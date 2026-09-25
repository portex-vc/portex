import { permanentRedirect } from "next/navigation";

/** The documentation moved to /docs; old links keep working (the browser keeps any #anchor). */
export default function WikiRedirect() {
  permanentRedirect("/docs");
}
