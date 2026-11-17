"use client";

import { RefreshCw } from "lucide-react";

export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="grid min-h-dvh place-items-center p-6 text-center">
      <div className="max-w-sm space-y-4">
        <h1 className="text-xl font-semibold">Something went wrong</h1>
        <p className="text-sm text-muted">An unexpected error occurred. Your lessons are safe - please try again.</p>
        <button type="button" onClick={reset} className="btn-primary inline-flex items-center gap-1.5 rounded-xl px-4 py-2 text-sm font-semibold">
          <RefreshCw className="size-4" /> Try again
        </button>
      </div>
    </main>
  );
}
