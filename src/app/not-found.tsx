import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { Header } from "@/components/brand/Header";

export default function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col">
      <Header showNew={false} />
      <main className="grid flex-1 place-items-center p-6 text-center">
        <div className="max-w-sm space-y-4">
          <p className="gradient-text text-6xl font-semibold">404</p>
          <h1 className="text-xl font-semibold">This page isn&apos;t on the board</h1>
          <p className="text-sm text-muted">The page you&apos;re looking for doesn&apos;t exist or has moved.</p>
          <Link href="/" className="btn-primary inline-flex items-center gap-1.5 rounded-xl px-4 py-2 text-sm font-semibold">
            <ArrowLeft className="size-4" /> Back home
          </Link>
        </div>
      </main>
    </div>
  );
}
