/** The AI Accounting Assistant mark: two rounded pages (violet and teal) with a gold spark between them. */
export function Logo({ size = 32, className }: { size?: number; className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 64 64"
      width={size}
      height={size}
      className={className}
      aria-hidden="true"
    >
      <rect x="6" y="12" width="32" height="40" rx="10" fill="#7C3AED" />
      <rect x="26" y="12" width="32" height="40" rx="10" fill="#0D9488" />
      <path d="M36 12h2v40h-2a10 10 0 0 1-10-10V22a10 10 0 0 1 10-10z" fill="#1B1840" />
      <path
        d="M32 22C32.9 29 34 30.1 41 31C34 31.9 32.9 33 32 40C31.1 33 30 31.9 23 31C30 30.1 31.1 29 32 22Z"
        fill="#FCD34D"
      />
    </svg>
  );
}
