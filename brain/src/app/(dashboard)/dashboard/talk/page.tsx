import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/PageHeader";
import { requireOwnerSession } from "@/lib/dashboard/owner";
import { config } from "@/lib/env";
import { MAX_SECONDS } from "@/lib/talk/audio";
import { TalkPanel } from "./TalkPanel";

export const metadata: Metadata = { title: "Talk" };
export const dynamic = "force-dynamic";

export default async function TalkPage() {
  await requireOwnerSession();
  return (
    <>
      <PageHeader
        title="Talk"
        lede={`Tap the mic, ask SideKiqq anything, and it answers out loud. It stops when you go quiet, tap again, or after ${MAX_SECONDS} seconds. Drafts it writes wait for you on Drafts; nothing is sent from here.`}
      />
      <TalkPanel speakMaxChars={config.speakMaxChars()} />
    </>
  );
}
