"use client";

import { useState } from "react";

export function ProfileForm({ initialName }: { initialName: string }) {
  const [name, setName] = useState(initialName);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/v1/me/learning", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "profile.save", displayName: name }),
      });
      if (!response.ok) throw new Error();
      setMessage("Profile saved.");
    } catch {
      setMessage("Profile could not be saved. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-7 space-y-3">
      <label className="block text-sm font-medium text-ink" htmlFor="display-name">Display name</label>
      <input id="display-name" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} className="w-full rounded-lg border border-line-strong bg-surface px-3 py-2 text-ink" />
      <button disabled={busy} className="rounded-lg bg-accent px-4 py-2 font-medium text-white disabled:opacity-60" type="submit">{busy ? "Saving…" : "Save profile"}</button>
      <p aria-live="polite" className="text-sm text-ink-soft">{message}</p>
    </form>
  );
}
