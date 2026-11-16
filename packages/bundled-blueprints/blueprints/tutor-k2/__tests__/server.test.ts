// The tutor's Durable Object as the Workshop runs it: the `LLM` binding it is given, the storage it
// keeps the conversation in, and the export a learner hands their teacher. The other three tutors'
// servers are this one with another persona.
import { describe, expect, it } from "vitest";
import { ExportHandler, Gadget } from "../files/server.ts";
import { PERSONA } from "../files/lib/persona.ts";

function storage() {
  const data = new Map<string, unknown>();
  return { get: async (key: string) => data.get(key), put: async (key: string, value: unknown) => void data.set(key, value) };
}

describe("Reading Buddy's Durable Object", () => {
  it("asks its LLM binding with the persona's system prompt, and exports the conversation", async () => {
    const prompts: string[] = [];
    const LLM = { run: async ({ prompt }: { prompt: string; systemPrompt?: string }) => (prompts.push(prompt), "The caterpillar was hungry! What did it eat first?") };
    const gadget = new Gadget({ storage: storage() } as unknown as DurableObjectState, { LLM });
    await gadget.setTopic("The Very Hungry Caterpillar");
    expect(await gadget.ask("It ate an apple")).toMatchObject({ ok: true, reply: "The caterpillar was hungry! What did it eat first?" });
    expect(prompts[0]).toContain("It ate an apple");

    const exported = await new Response(await new ExportHandler({} as never, {}).export(gadget, "markdown")).text();
    expect(exported).toContain(`# ${PERSONA.name}`);
    expect(exported).toContain("**Me:** It ate an apple");
    await expect(new ExportHandler({} as never, {}).export(gadget, "pdf")).rejects.toThrow("Unsupported");
  });

  it("tells the learner when no model is connected", async () => {
    const gadget = new Gadget({ storage: storage() } as unknown as DurableObjectState, {});
    expect(await gadget.ask("hello")).toMatchObject({ ok: false });
  });
});
