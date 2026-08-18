import { cn } from "@/lib/utils";

/**
 * Decorative ECG waveform that draws itself across the hero and loops.
 * Purely presentational — hidden from assistive tech.
 */
export function EcgTrace({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 1200 160"
      preserveAspectRatio="none"
      className={cn("h-full w-full", className)}
    >
      <defs>
        <linearGradient id="ecg-stroke" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0" />
          <stop offset="18%" stopColor="currentColor" stopOpacity="0.85" />
          <stop offset="82%" stopColor="currentColor" stopOpacity="0.85" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path
        d="M0 96 H140 l18 -6 l16 12 l14 -46 l18 96 l16 -62 l14 6 H420 l20 -8 l16 14 l14 -48 l18 98 l16 -64 l14 8 H760 l18 -6 l16 12 l14 -46 l18 96 l16 -62 l14 6 H1200"
        fill="none"
        stroke="url(#ecg-stroke)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="animate-ecg"
      />
    </svg>
  );
}
