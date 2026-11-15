import { classifyRpcError, logRpcFailure, rpcFailureDescription } from "../../rpcErrors";
import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useKumoToastManager } from "@cloudflare/kumo";
import { HomeLanding } from "./HomeLanding";
import { ChatComposer } from "../../features/chat/composer/ChatComposer";
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
import { TeacherOnboarding } from "../../features/teacher-onboarding/TeacherOnboarding";
import { SchoolContextChip } from "../../features/school-context/SchoolContextChip";
import { useSchoolContextLink } from "../../features/school-context/schoolContext";
import { schoolContextPreamble } from "@gadgets/workshop-shared/school-context";

export const HomePage = ({ prompt, teacherOnboarding = false }: { prompt?: string; teacherOnboarding?: boolean }) => {
  const district = useDistrictSidebar();
  useDocumentTitle(teacherOnboarding ? "Bring your classroom" : district ? "AI workspace" : "Home");

  const { authenticatedApi, currentUser, preferredModel } = useAuthenticatedApi();
  const navigate = useNavigate();
  const toasts = useKumoToastManager();

  const [models, setModels] = useState<AiChatAuthorInfo[]>([]);
  // Wrapped, so that a pick of "No agent" (null) is told from no pick at all.
  const [pickedModel, setPickedModel] = useState<{ modelId: string | null } | null>(null);
  const selectedModel = pickedModel ? pickedModel.modelId : getStoredSelectedModel(models, preferredModel);
  // Bumped each time a task suggestion is picked; the composer re-seeds its text off the nonce.
  const [seed, setSeed] = useState<{ text: string; nonce: number } | null>(null);
  const draftStorageKey = currentUser
    ? composerDraftStorageKey(currentUser.id, teacherOnboarding ? "teacher-onboarding" : "home")
    : undefined;
  // "Ask AI about this" (SCHO-260): a context the district confirmed, attached to the new chat.
  const [schoolContext, dismissSchoolContext] = useSchoolContextLink(authenticatedApi);
  const attachedContext = !teacherOnboarding && schoolContext.status === "attached" ? schoolContext.context : undefined;

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
    setPickedModel({ modelId: value });
    persistSelectedModel(value);
  }, []);

  // Pre-create a provisional gadget as soon as the user starts interacting, so that navigation
  // after submit is instant. Same pattern as before — disposed on unmount if never consumed.
  const provisionalOverseerRef = useRef<{ stub: RpcStub<Overseer> } | null>(null);

  const ensureProvisionalGadget = useCallback(() => {
    if (!provisionalOverseerRef.current) {
      const overseer = authenticatedApi.newWorkspace();
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
        showAttachmentActions={teacherOnboarding}
        autoFocus
        minRows={3}
        seedText={seed?.text}
        seedNonce={seed?.nonce}
        draftStorageKey={draftStorageKey}
      />
    </>
  );

  return teacherOnboarding ? (
    <TeacherOnboarding
      key={draftStorageKey}
      composer={composer}
      draftStorageKey={draftStorageKey}
      onPrepare={(text) => setSeed({ text, nonce: 1 })}
      onBack={() => navigate({ to: "/", search: {} })}
    />
  ) : (
    <HomeLanding
      composer={composer}
      onPick={(text) => setSeed((previous) => ({ text, nonce: (previous?.nonce ?? 0) + 1 }))}
      onTeacherOnboarding={() => navigate({ to: "/teacher-onboarding" })}
    />
  );
};
