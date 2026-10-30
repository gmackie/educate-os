import { classifyRpcError, logRpcFailure, rpcFailureDescription } from "../../rpcErrors";
import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate } from "@tanstack/react-router";
import { LayerCard, useKumoToastManager } from "@cloudflare/kumo";
import { Sparkle } from "@phosphor-icons/react";
import { ChatComposer } from "../../features/chat/composer/ChatComposer";
import MeshBackground from "./MeshBackground";
import HomeTaskSuggestions from "./HomeTaskSuggestions";
import { SchoolHomeIntro } from "./SchoolHomeIntro";
import { SchoolTaskSuggestions } from "./SchoolTaskSuggestions";
import { UpdateAvailableNotice } from "../../features/deployment-updates/UpdateAvailableNotice";
import { useAuthenticatedApi } from "../../AuthContext";
import { useDistrictSidebar } from "../../features/district-frame/districtFrame";
import { RpcStub } from "capnweb";
import {
  Overseer,
  AiChatAuthorInfo,
  CapsuleSpecifier,
  ChatAttachmentHandle,
  MessageFormatRef,
  SlashCommandRequest,
} from "@gadgets/workshop-shared/api";
import {
  getStoredSelectedModel,
  persistSelectedModel,
} from "../../modelSelection";
import { useDocumentTitle } from "../../useDocumentTitle";
import { composerDraftStorageKey } from "../../features/chat/composer/draft/composerDraft";
import { SchoolContextChip } from "../../features/school-context/SchoolContextChip";
import { useSchoolContextLink } from "../../features/school-context/schoolContext";
import { schoolContextPreamble } from "@gadgets/workshop-shared/school-context";

export const HomePage = ({ prompt }: { prompt?: string }) => {
  const district = useDistrictSidebar();
  useDocumentTitle(district ? "AI workspace" : "Home");

  const { authenticatedApi, currentUser } = useAuthenticatedApi();
  const navigate = useNavigate();
  const toasts = useKumoToastManager();

  const [models, setModels] = useState<AiChatAuthorInfo[]>([]);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  // Bumped each time a task suggestion is picked; the composer re-seeds its text off the nonce.
  const [seed, setSeed] = useState<{ text: string; nonce: number } | null>(null);
  // "Ask AI about this" (SCHO-260): a context the district confirmed, attached to the new chat.
  const [schoolContext, dismissSchoolContext] = useSchoolContextLink(authenticatedApi);
  const attachedContext = schoolContext.status === "attached" ? schoolContext.context : undefined;

  useEffect(() => {
    if (schoolContext.status !== "refused") return;
    // Nothing about why: an unknown ID and someone else's look the same.
    toasts.add({
      title: "Couldn't open that in the AI workspace",
      description: "It isn't available to you here. Start a new chat instead.",
      variant: "error",
    });
    dismissSchoolContext();
  }, [schoolContext.status, dismissSchoolContext, toasts]);

  useEffect(() => {
    if (!prompt) return;
    setSeed((previous) => ({ text: prompt, nonce: (previous?.nonce ?? 0) + 1 }));
    navigate({ to: "/", search: {}, replace: true });
  }, [navigate, prompt]);

  useEffect(() => {
    let cancelled = false;
    authenticatedApi.listModels()
      .then((list) => {
        if (cancelled) return;
        setModels(list);
        setSelectedModel(getStoredSelectedModel(list));
      })
      .catch((err) => {
        logRpcFailure("Failed to fetch models:", err);
        // Toast unless it's a connection error (reconnect refetches); a do-reset here already
        // survived the Worker's same-colo retry, so the user should hear about it.
        if (classifyRpcError(err) !== "connection") {
          toasts.add({ title: "Couldn't load AI models", variant: "error" });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [authenticatedApi]);

  const handleModelChange = useCallback((value: string | null) => {
    setSelectedModel(value);
    persistSelectedModel(value);
  }, []);

  // Pre-create a provisional gadget as soon as the user starts interacting, so that navigation
  // after submit is instant. Same pattern as before — disposed on unmount if never consumed.
  const provisionalOverseerRef = useRef<{ stub: RpcStub<Overseer> } | null>(null);

  const ensureProvisionalGadget = useCallback(() => {
    if (!provisionalOverseerRef.current) {
      const overseer = authenticatedApi.newGadget();
      provisionalOverseerRef.current = { stub: overseer };
    }
  }, [authenticatedApi]);

  useEffect(() => {
    return () => {
      provisionalOverseerRef.current?.stub[Symbol.dispose]();
      provisionalOverseerRef.current = null;
    };
  }, []);

  const handleSend = useCallback(
    async (
      message: string | SlashCommandRequest,
      modelId: string | null,
      capsules?: CapsuleSpecifier[],
      attachments?: ChatAttachmentHandle[],
      formats?: MessageFormatRef[],
    ) => {
      // The attached context leads the first message, so the model knows what "this" is.
      if (attachedContext !== undefined && typeof message === "string") {
        message = `${schoolContextPreamble(attachedContext)}\n\n${message}`;
      }
      try {
        ensureProvisionalGadget();
        const overseer = provisionalOverseerRef.current!.stub;
        // Pipeline both independent calls in one batch, but settle both before releasing the stub.
        const [chat, {id}] = await Promise.all([
          overseer.newChat(message, modelId, capsules, attachments, formats),
          overseer.getMetadata(),
        ]);
        provisionalOverseerRef.current?.stub[Symbol.dispose]();
        provisionalOverseerRef.current = null;
        // Open the conversation we just started.
        navigate({ to: "/workspace/$id", params: { id }, search: { chat } });
      } catch (err) {
        const transient = logRpcFailure("Failed to create gadget:", err,
            { reportSite: "workspace.create" });
        // A retry reuses the provisional gadget while the draft contains gadget-scoped references.
        if (!attachments?.length && !capsules?.length) {
          provisionalOverseerRef.current?.stub[Symbol.dispose]();
          provisionalOverseerRef.current = null;
        }
        if (!transient) {
          toasts.add({
            title: "Failed to create workspace",
            description: rpcFailureDescription(err),
            variant: "error",
          });
        }
        throw err;
      }
    },
    [attachedContext, ensureProvisionalGadget, navigate, toasts],
  );

  const getOverseer = useCallback((): RpcStub<Overseer> => {
    ensureProvisionalGadget();
    return provisionalOverseerRef.current!.stub;
  }, [ensureProvisionalGadget]);

  const createCapsuleGatekeeper = useCallback(
    (accountId: number, url: string) => {
      ensureProvisionalGadget();
      return provisionalOverseerRef.current!.stub.newGatekeeper(accountId, url);
    },
    [ensureProvisionalGadget],
  );

  const composer = (
    <>
      {attachedContext === undefined ? null : (
        <div className={district ? "px-4 pt-4" : undefined}>
          <SchoolContextChip context={attachedContext} onRemove={dismissSchoolContext} />
        </div>
      )}
      <ChatComposer
        createCapsuleGatekeeper={createCapsuleGatekeeper}
        getOverseer={getOverseer}
        onSend={handleSend}
        isAgentActive={false}
        models={models}
        selectedModel={selectedModel === null ? null : { id: selectedModel }}
        onModelChange={handleModelChange}
        newChat
        offerFormats
        autoFocus
        minRows={3}
        seedText={seed?.text}
        seedNonce={seed?.nonce}
        draftStorageKey={currentUser
          ? composerDraftStorageKey(currentUser.id, "home")
          : undefined}
      />
    </>
  );

  return (
    <div className={`relative isolate flex min-h-full w-full flex-col items-center px-4 pb-12 sm:px-8 ${district ? "pt-8 sm:pt-12" : "pt-10 sm:pt-16 lg:pt-24"}`}>
      <UpdateAvailableNotice />
      {!district && <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[460px] overflow-hidden"
        style={{
          maskImage:
            "linear-gradient(to bottom, rgba(0,0,0,1) 0%, rgba(0,0,0,1) 45%, rgba(0,0,0,0) 95%)",
          WebkitMaskImage:
            "linear-gradient(to bottom, rgba(0,0,0,1) 0%, rgba(0,0,0,1) 45%, rgba(0,0,0,0) 95%)",
        }}
      >
        <MeshBackground />
      </div>}
      <div className={`flex w-full flex-col items-stretch gap-8 ${district ? "max-w-3xl" : "max-w-2xl"}`}>
        {district ? <SchoolHomeIntro /> : <header className="text-center">
          <h1 className="text-3xl font-semibold tracking-tight leading-tight text-kumo-default sm:text-4xl">
            What are we working on?
          </h1>
          <p className="mx-auto mt-3 max-w-md text-[14px] leading-5 tracking-[-0.25px] text-kumo-subtle">
            Ask a question, create an output, or create an app that works with your tools and data.
          </p>
        </header>}

        {district ? (
          <LayerCard className="overflow-visible rounded-2xl">
            <LayerCard.Secondary className="justify-between px-5 py-4">
              <h2 className="text-sm font-medium text-kumo-default">Start a conversation</h2>
              <Sparkle size={18} className="text-kumo-brand" aria-hidden="true" />
            </LayerCard.Secondary>
            <LayerCard.Primary className="gap-0 overflow-visible p-0 pr-0">{composer}</LayerCard.Primary>
          </LayerCard>
        ) : composer}

        {district ? (
          <SchoolTaskSuggestions onPick={(text) => setSeed((prev) => ({ text, nonce: (prev?.nonce ?? 0) + 1 }))} />
        ) : (
          <HomeTaskSuggestions onPick={(text) => setSeed((prev) => ({ text, nonce: (prev?.nonce ?? 0) + 1 }))} />
        )}
      </div>
    </div>
  );
};
