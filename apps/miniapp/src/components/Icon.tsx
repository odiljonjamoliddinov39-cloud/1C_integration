/** The few line icons the screens use: drawn here so the page needs no icon font and no request. */
const PATHS = {
  chat: ["M21 12a8 8 0 0 1-11.6 7.1L4 20l1.1-4.5A8 8 0 1 1 21 12z"],
  waiting: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z", "M12 7.5V12l3 2"],
  files: ["M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z", "M14 3v5h5", "M9 13h6", "M9 17h4"],
  status: ["M3 12h4l3-8 4 16 3-8h4"],
  send: ["M12 19V5", "M5.5 11.5 12 5l6.5 6.5"],
  clip: ["M20.5 11.5 12 20a5 5 0 0 1-7-7l9-9a3.3 3.3 0 0 1 4.7 4.7l-9 9a1.7 1.7 0 0 1-2.4-2.4l8.2-8.2"],
  check: ["M5 12.5l4.2 4.2L19 7"],
  laptop: ["M5 6h14v10H5z", "M2.5 20h19"],
  inbox: ["M22 12h-5.5l-2 3h-5l-2-3H2", "M5.6 5h12.8l3.6 7v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z"],
  spark: ["M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z", "M19 16.5v3", "M17.5 18h3"],
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 22 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
