import Link from "next/link";

export function LogoMark({ className = "size-9" }: { className?: string }) {
  return (
    <span className={`btn-primary grid shrink-0 place-items-center rounded-xl ${className}`} aria-hidden>
      <svg viewBox="0 0 32 32" className="size-[62%]" fill="none">
        <rect x="3" y="5" width="26" height="17" rx="3.5" fill="#fffdf8" />
        <path d="M7 17c3-5 5 3 8-1s4-3.4 7-5.4" stroke="#5645ff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M16 22v5m-5.5 0h11" stroke="#fffdf8" strokeWidth="2.2" strokeLinecap="round" />
      </svg>
    </span>
  );
}

export function Logo() {
  return (
    <Link href="/" className="flex items-center gap-2.5 rounded-xl text-[15px] font-semibold tracking-tight" aria-label="Whiteboard Tutor home">
      <LogoMark />
      <span className="hidden sm:inline">Whiteboard Tutor</span>
    </Link>
  );
}
