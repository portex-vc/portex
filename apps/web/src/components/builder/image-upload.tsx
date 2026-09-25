"use client";

import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { humanizeError } from "@/lib/errors";
import { checkImageFile, dataUrlPayload, IMAGE_ACCEPT, uploadFailure } from "@/lib/image-upload";
import { useNumbers } from "@/lib/use-numbers";
import { cn } from "@/lib/utils";
import { ImagePlus, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";
import { useAccount, useSignMessage } from "wagmi";

type Phase = "idle" | "reading" | "signing" | "uploading";

function readDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

function imageSize(url: string) {
  return new Promise<{ width: number; height: number }>((resolve, reject) => {
    const img = new window.Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error("decode failed"));
    img.src = url;
  });
}

/**
 * Optional project image: a square preview, client-side type and size checks, then a signed
 * POST /v2/uploads. The returned `uri` is stored on the profile when the builder saves it.
 * A missing or unreachable upload endpoint is explained inline and never blocks the rest of the form.
 */
export function ProjectImageField({
  symbol,
  imageUrl,
  onChange,
  disabled,
}: {
  symbol: string;
  /** What the project shows today (uploaded image, legacy logo, or null for the monogram). */
  imageUrl: string | null;
  onChange: (next: { uri: string; url: string } | null) => void;
  disabled?: boolean;
}) {
  const t = useTranslations("builderConsole.image");
  const te = useTranslations("errors");
  const n = useNumbers();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const { address } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<{ message: string; retry?: File } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [local, setLocal] = useState<string | null>(null);
  const [broken, setBroken] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const busy = phase !== "idle";
  const shown = local ?? (imageUrl && broken !== imageUrl ? imageUrl : null);

  useEffect(() => () => void (local && URL.revokeObjectURL(local)), [local]);

  async function upload(file: File) {
    if (busy || disabled || !address) return;
    setError(null);
    setNote(null);
    const problem = checkImageFile(file);
    if (problem) {
      setError({
        message:
          problem === "size"
            ? t("errorSize", { size: `${n.number(file.size / (1024 * 1024), 1)} MB` })
            : t(problem === "type" ? "errorType" : "errorEmpty"),
      });
      return;
    }
    const objectUrl = URL.createObjectURL(file);
    setPhase("reading");
    try {
      const { width, height } = await imageSize(objectUrl);
      if (width !== height) setNote(t("cropped"));
      const data = dataUrlPayload(await readDataUrl(file));
      setLocal(objectUrl);
      setPhase("signing");
      const result = await api.upload(
        { contentType: file.type, data },
        {
          address,
          signMessage: async (args) => {
            const signature = await signMessageAsync({ ...args, account: address });
            setPhase("uploading");
            return signature;
          },
        },
      );
      onChange({ uri: result.uri, url: result.url });
    } catch (err) {
      setLocal(null);
      URL.revokeObjectURL(objectUrl);
      const failure = uploadFailure(err);
      const decode = err instanceof Error && err.message === "decode failed";
      setError({
        message: decode
          ? t("errorDecode")
          : failure === "unavailable"
            ? t("errorUnavailable")
            : failure === "offline"
              ? t("errorOffline")
              : failure === "tooLarge"
                ? t("errorSize", { size: `${n.number(file.size / (1024 * 1024), 1)} MB` })
                : failure === "rejected" && err instanceof Error
                  ? t("errorRejected", { reason: err.message })
                  : humanizeError(err, te),
        retry: decode ? undefined : file,
      });
    } finally {
      setPhase("idle");
      if (input.current) input.current.value = "";
    }
  }

  const status =
    phase === "reading" || phase === "signing" ? t("signing") : phase === "uploading" ? t("uploading") : null;

  return (
    <div className="flex items-start gap-4" data-testid="project-image">
      <button
        type="button"
        aria-describedby={`${id}-hint`}
        aria-label={shown ? t("replace") : t("choose")}
        disabled={busy || disabled}
        onClick={() => input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const file = e.dataTransfer.files?.[0];
          if (file) void upload(file);
        }}
        className={cn(
          "group relative isolate flex size-20 shrink-0 items-center sm:size-24 justify-center overflow-hidden rounded-[18px] bg-fg/[0.04] text-fg-3 transition-[border-color,background-color,transform] duration-200 ease-out hover:bg-fg/[0.06] hover:text-fg-2 active:scale-[0.98] disabled:cursor-progress",
          !shown && "border border-dashed border-fg/[0.18] hover:border-fg/[0.3]",
          dragging && "bg-fg/[0.08] outline outline-2 outline-offset-2 outline-fg/40",
        )}
      >
        {shown ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={shown}
            alt=""
            className="size-full object-cover"
            onError={() => (local ? null : setBroken(imageUrl))}
          />
        ) : (
          <span className="flex flex-col items-center gap-1.5 text-2xs">
            <ImagePlus className="size-5" aria-hidden />
            <span className="font-mono text-[0.625rem] tracking-wide text-fg-3">{symbol.slice(0, 4)}</span>
          </span>
        )}
        {shown ? (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-[inherit] ring-1 ring-inset ring-fg/[0.1]"
          />
        ) : null}
        {busy ? (
          <span className="absolute inset-0 flex items-center justify-center bg-bg/55 backdrop-blur-[2px]">
            <Loader2 className="size-5 animate-spin text-fg" aria-hidden />
          </span>
        ) : null}
      </button>
      <div className="min-w-0 flex-1 space-y-2.5">
        <div>
          <p className="text-sm text-fg">{t("title")}</p>
          <p id={`${id}-hint`} className="mt-1 text-xs leading-relaxed text-fg-3">
            {t("hint")}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy || disabled}
            onClick={() => input.current?.click()}
            data-testid="project-image-choose"
          >
            <ImagePlus aria-hidden />
            {shown ? t("replace") : t("choose")}
          </Button>
          {shown && !busy ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled}
              onClick={() => {
                setLocal(null);
                setNote(t("removed"));
                setError(null);
                onChange(null);
              }}
            >
              <Trash2 aria-hidden />
              {t("remove")}
            </Button>
          ) : null}
        </div>
        <p aria-live="polite" className="min-h-4 text-xs leading-relaxed">
          {status ? (
            <span className="text-fg-2">{status}</span>
          ) : error ? (
            <span className="inline-flex flex-wrap items-center gap-x-2 text-negative" role="alert">
              {error.message}
              {error.retry ? (
                <button
                  type="button"
                  className="inline-flex items-center gap-1 text-fg-2 underline decoration-fg/25 underline-offset-4 hover:text-fg"
                  onClick={() => error.retry && void upload(error.retry)}
                >
                  <RefreshCw className="size-3" aria-hidden />
                  {t("retry")}
                </button>
              ) : null}
            </span>
          ) : local ? (
            <span className="text-fg-2">
              {t("uploaded")}
              {note ? <span className="text-fg-3"> {note}</span> : null}
            </span>
          ) : note ? (
            <span className="text-fg-3">{note}</span>
          ) : null}
        </p>
      </div>
      <input
        ref={input}
        type="file"
        accept={IMAGE_ACCEPT}
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        data-testid="project-image-input"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void upload(file);
        }}
      />
    </div>
  );
}
