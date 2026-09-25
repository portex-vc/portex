import type {
  IChartApi,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesPrimitive,
  SeriesAttachedParameter,
  Time,
  UTCTimestamp,
} from "lightweight-charts";

type Target = Parameters<IPrimitivePaneRenderer["draw"]>[0];

export interface ListingMarkerStyle {
  /** The dashed vertical line. */
  line: string;
  /** Pill background and text. */
  pill: string;
  text: string;
  font: string;
}

/** Pill geometry in CSS pixels, from the top of the pane. */
const PILL_TOP = 4;
const PILL_HEIGHT = 18;
const PILL_PAD = 7;

/**
 * The listing moment: a thin dashed vertical line across the whole pane at the listing bucket, with a small
 * neutral "Listed" pill at the top. It is a series primitive, so the library redraws it on every scroll and zoom
 * from `timeToCoordinate`, and it never touches the page layout.
 */
export class ListingMarker implements ISeriesPrimitive<Time> {
  private chart: IChartApi | null = null;
  private requestUpdate: (() => void) | null = null;
  private time: UTCTimestamp | null = null;
  private label = "";
  private x: number | null = null;
  private readonly views: readonly IPrimitivePaneView[];

  constructor(private readonly style: ListingMarkerStyle) {
    this.views = [
      { zOrder: () => "bottom", renderer: () => ({ draw: (target: Target) => this.drawLine(target) }) },
      { zOrder: () => "top", renderer: () => ({ draw: (target: Target) => this.drawPill(target) }) },
    ];
  }

  attached({ chart, requestUpdate }: SeriesAttachedParameter<Time>) {
    this.chart = chart as IChartApi;
    this.requestUpdate = requestUpdate;
  }

  detached() {
    this.chart = null;
    this.requestUpdate = null;
  }

  /** Places the marker at `time` (a bar time on the chart), or hides it with `null`. */
  set(time: UTCTimestamp | null, label: string) {
    if (time === this.time && label === this.label) return;
    this.time = time;
    this.label = label;
    this.requestUpdate?.();
  }

  updateAllViews() {
    this.x = this.time === null || !this.chart ? null : this.chart.timeScale().timeToCoordinate(this.time);
  }

  paneViews() {
    return this.views;
  }

  private drawLine(target: Target) {
    target.useBitmapCoordinateSpace(({ context, bitmapSize, horizontalPixelRatio, verticalPixelRatio }) => {
      if (this.x === null) return;
      const width = Math.max(1, Math.floor(horizontalPixelRatio));
      const x = Math.round(this.x * horizontalPixelRatio) + (width % 2 ? 0.5 : 0);
      if (x < 0 || x > bitmapSize.width) return;
      context.save();
      context.strokeStyle = this.style.line;
      context.lineWidth = width;
      context.setLineDash([3 * verticalPixelRatio, 3 * verticalPixelRatio]);
      context.beginPath();
      context.moveTo(x, Math.round((PILL_TOP + PILL_HEIGHT) * verticalPixelRatio));
      context.lineTo(x, bitmapSize.height);
      context.stroke();
      context.restore();
    });
  }

  private drawPill(target: Target) {
    target.useMediaCoordinateSpace(({ context, mediaSize }) => {
      if (this.x === null || !this.label || this.x < 0 || this.x > mediaSize.width) return;
      context.save();
      context.font = this.style.font;
      const width = Math.ceil(context.measureText(this.label).width) + PILL_PAD * 2;
      // Centred on the line, kept inside the pane near either edge.
      const left = Math.round(Math.min(Math.max(this.x - width / 2, 1), mediaSize.width - width - 1));
      context.beginPath();
      context.roundRect(left, PILL_TOP, width, PILL_HEIGHT, PILL_HEIGHT / 2);
      context.fillStyle = this.style.pill;
      context.fill();
      context.fillStyle = this.style.text;
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(this.label, left + width / 2, PILL_TOP + PILL_HEIGHT / 2 + 0.5);
      context.restore();
    });
  }
}
