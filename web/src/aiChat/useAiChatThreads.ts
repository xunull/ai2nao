import { useAssistantRuntime, useAui, useAuiState } from "@assistant-ui/react";
import { useCallback, useEffect, useReducer, useRef } from "react";
import type { UIMessage } from "ai";
import {
  createAiChatSession,
  deleteAiChatSession,
  getAiChatSession,
  listAiChatSessions,
  syncAiChatSession,
} from "./sessionApi";
import type { AiChatSessionSummary } from "./types";
import {
  encodeMessageForSync,
  extractMessageText,
  restoreSessionMessages,
  titleFromMessages,
  toThreadMessageLike,
} from "./messageCodec";
import {
  clearRestoredBaseMessages,
  mergeWithRestoredBase,
  setRestoredBaseMessages,
} from "./runtimeBridge";

export type AiChatThreadStatus =
  | "idle"
  | "loading"
  | "restoring"
  | "saving"
  | "saved"
  | "save_error"
  | "restore_error";

type State = {
  sessions: AiChatSessionSummary[];
  activeSessionId: string | null;
  status: AiChatThreadStatus;
  error: string | null;
  lastSavedAt: string | null;
  restoredMessages: UIMessage[];
};

type Action =
  | { type: "sessions_loading" }
  | { type: "sessions_loaded"; sessions: AiChatSessionSummary[] }
  | { type: "sessions_error"; error: string }
  | { type: "restore_start" }
  | { type: "restore_success"; session: AiChatSessionSummary; messages: UIMessage[] }
  | { type: "restore_error"; error: string }
  | { type: "new_thread" }
  | { type: "save_start" }
  | { type: "save_success"; session: AiChatSessionSummary; savedAt: string }
  | { type: "session_upsert"; session: AiChatSessionSummary }
  | { type: "save_error"; error: string }
  | { type: "delete_success"; id: string };

const initialState: State = {
  sessions: [],
  activeSessionId: null,
  status: "idle",
  error: null,
  lastSavedAt: null,
  restoredMessages: [],
};

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "sessions_loading":
      return { ...state, status: state.status === "idle" ? "loading" : state.status };
    case "sessions_loaded":
      return { ...state, sessions: action.sessions, status: state.status === "loading" ? "idle" : state.status };
    case "sessions_error":
      return { ...state, status: "restore_error", error: action.error };
    case "restore_start":
      return { ...state, status: "restoring", error: null };
    case "restore_success":
      return {
        ...state,
        activeSessionId: action.session.id,
        status: "idle",
        error: null,
        lastSavedAt: action.session.updated_at,
        restoredMessages: action.messages,
      };
    case "restore_error":
      return { ...state, status: "restore_error", error: action.error };
    case "new_thread":
      return { ...state, activeSessionId: null, status: "idle", error: null, lastSavedAt: null, restoredMessages: [] };
    case "save_start":
      return { ...state, status: "saving", error: null };
    case "save_success": {
      return {
        ...state,
        activeSessionId: action.session.id,
        status: "saved",
        error: null,
        lastSavedAt: action.savedAt,
        sessions: upsertSession(state.sessions, action.session),
      };
    }
    case "session_upsert":
      return {
        ...state,
        sessions: upsertSession(state.sessions, action.session),
      };
    case "save_error":
      return { ...state, status: "save_error", error: action.error };
    case "delete_success": {
      const activeDeleted = action.id === state.activeSessionId;
      return {
        ...state,
        sessions: state.sessions.filter((session) => session.id !== action.id),
        activeSessionId: activeDeleted ? null : state.activeSessionId,
        status: activeDeleted ? "idle" : state.status,
        error: activeDeleted ? null : state.error,
        restoredMessages: activeDeleted ? [] : state.restoredMessages,
      };
    }
  }
}

function upsertSession(sessions: AiChatSessionSummary[], session: AiChatSessionSummary) {
  const next = sessions.filter((item) => item.id !== session.id);
  return [session, ...next].sort((a, b) =>
    (b.last_message_at ?? b.updated_at).localeCompare(a.last_message_at ?? a.updated_at)
  );
}

function signatureForMessages(messages: readonly unknown[]): string {
  return JSON.stringify(
    messages.map((message, index) => {
      const m = message as { id?: unknown; role?: unknown; status?: unknown };
      return {
        index,
        id: typeof m?.id === "string" ? m.id : null,
        role: m?.role,
        status: m?.status,
        text: extractMessageText(message),
      };
    })
  );
}

function nextTick() {
  return Promise.resolve();
}

export function useAiChatThreads() {
  const aui = useAui();
  const assistantRuntime = useAssistantRuntime({ optional: true });
  const runtimeMessages = useAuiState((s) => s.thread.messages);
  const isRunning = useAuiState((s) => s.thread.isRunning);
  const [state, dispatch] = useReducer(reducer, initialState);
  const generationRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const activeSessionRef = useRef<string | null>(null);
  const messagesRef = useRef<readonly unknown[]>([]);
  const lastSyncedRef = useRef<string | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    activeSessionRef.current = state.activeSessionId;
  }, [state.activeSessionId]);

  useEffect(() => {
    messagesRef.current = runtimeMessages;
  }, [runtimeMessages]);

  const nextGeneration = useCallback(() => {
    generationRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    return { generation: generationRef.current, signal: abortRef.current.signal };
  }, []);

  const refreshSessions = useCallback(async () => {
    const { generation, signal } = nextGeneration();
    dispatch({ type: "sessions_loading" });
    try {
      const sessions = await listAiChatSessions({ signal });
      if (generation !== generationRef.current) return;
      dispatch({ type: "sessions_loaded", sessions });
    } catch (e) {
      if (signal.aborted || generation !== generationRef.current) return;
      dispatch({ type: "sessions_error", error: e instanceof Error ? e.message : String(e) });
    }
  }, [nextGeneration]);

  useEffect(() => {
    void refreshSessions();
  }, [refreshSessions]);

  const saveSnapshot = useCallback(
    async ({
      messages,
      sessionId,
      activate,
      generation,
      signal,
      signature,
    }: {
      messages: readonly unknown[];
      sessionId: string | null;
      activate: boolean;
      generation: number | null;
      signal: AbortSignal;
      signature: string;
    }) => {
      const syncMessages = messages.map((message, index) =>
        encodeMessageForSync(message, index)
      );
      let targetSessionId = sessionId;
      if (!targetSessionId) {
        const created = await createAiChatSession(titleFromMessages(syncMessages), { signal });
        if (signal.aborted || (generation !== null && generation !== generationRef.current)) return;
        targetSessionId = created.id;
        if (activate) activeSessionRef.current = targetSessionId;
      }
      const detail = await syncAiChatSession(
        targetSessionId,
        syncMessages,
        titleFromMessages(syncMessages),
        { signal }
      );
      if (signal.aborted || (generation !== null && generation !== generationRef.current)) return;
      if (activate) {
        activeSessionRef.current = detail.id;
        lastSyncedRef.current = signature;
        dispatch({
          type: "save_success",
          session: detail,
          savedAt: detail.last_message_at ?? detail.updated_at,
        });
      } else {
        dispatch({ type: "session_upsert", session: detail });
      }
    },
    []
  );

  const saveNow = useCallback(async () => {
    const messages = mergeWithRestoredBase(messagesRef.current);
    if (isRunning || messages.length === 0) return;
    const signature = signatureForMessages(messages);
    if (signature === lastSyncedRef.current) return;
    const { generation, signal } = nextGeneration();
    dispatch({ type: "save_start" });
    try {
      await saveSnapshot({
        messages,
        sessionId: activeSessionRef.current,
        activate: true,
        generation,
        signal,
        signature,
      });
    } catch (e) {
      if (signal.aborted || generation !== generationRef.current) return;
      dispatch({ type: "save_error", error: e instanceof Error ? e.message : String(e) });
    }
  }, [isRunning, nextGeneration, saveSnapshot]);

  const resetFreshThread = useCallback(
    async (messages = [] as ReturnType<typeof toThreadMessageLike>[]) => {
      if (!assistantRuntime) return;
      await assistantRuntime.threads.switchToNewThread();
      await nextTick();
      assistantRuntime.thread.reset(messages);
    },
    [assistantRuntime]
  );

  useEffect(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    if (isRunning || runtimeMessages.length === 0) return;
    saveTimerRef.current = setTimeout(() => {
      void saveNow();
    }, 600);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [isRunning, runtimeMessages, saveNow]);

  const startNew = useCallback(() => {
    const previousMessages = mergeWithRestoredBase(messagesRef.current);
    const previousSessionId = activeSessionRef.current;
    const previousSignature = signatureForMessages(previousMessages);
    const previousLastSynced = lastSyncedRef.current;
    nextGeneration();
    assistantRuntime?.thread.cancelRun();
    void resetFreshThread();
    activeSessionRef.current = null;
    lastSyncedRef.current = null;
    clearRestoredBaseMessages();
    dispatch({ type: "new_thread" });
    if (
      previousMessages.length > 0 &&
      previousSignature !== previousLastSynced
    ) {
      const controller = new AbortController();
      void saveSnapshot({
        messages: previousMessages,
        sessionId: previousSessionId,
        activate: false,
        generation: null,
        signal: controller.signal,
        signature: previousSignature,
      }).catch((e) => {
        if (!controller.signal.aborted) {
          dispatch({ type: "save_error", error: e instanceof Error ? e.message : String(e) });
        }
      });
    }
  }, [assistantRuntime, nextGeneration, resetFreshThread, saveSnapshot]);

  const selectSession = useCallback(
    async (id: string) => {
      const previousMessages = mergeWithRestoredBase(messagesRef.current);
      const previousSessionId = activeSessionRef.current;
      const previousSignature = signatureForMessages(previousMessages);
      const { generation, signal } = nextGeneration();
      dispatch({ type: "restore_start" });
      try {
        if (
          previousMessages.length > 0 &&
          previousSignature !== lastSyncedRef.current
        ) {
          await saveSnapshot({
            messages: previousMessages,
            sessionId: previousSessionId,
            activate: false,
            generation,
            signal,
            signature: previousSignature,
          });
        }
        const detail = await getAiChatSession(id, { signal });
        const restored = restoreSessionMessages(detail);
        if (restored.errors.length > 0) {
          throw new Error(`会话恢复失败：${restored.errors.join("; ")}`);
        }
        if (generation !== generationRef.current) return;
        assistantRuntime?.thread.cancelRun();
        await resetFreshThread(restored.messages.map(toThreadMessageLike));
        setRestoredBaseMessages(restored.messages);
        activeSessionRef.current = id;
        lastSyncedRef.current = signatureForMessages(restored.messages);
        dispatch({ type: "restore_success", session: detail, messages: restored.messages });
      } catch (e) {
        if (signal.aborted || generation !== generationRef.current) return;
        dispatch({ type: "restore_error", error: e instanceof Error ? e.message : String(e) });
      }
    },
    [assistantRuntime, nextGeneration, resetFreshThread, saveSnapshot]
  );

  const removeSession = useCallback(
    async (id: string) => {
      const { generation, signal } = nextGeneration();
      try {
        await deleteAiChatSession(id, { signal });
        if (generation !== generationRef.current) return;
        dispatch({ type: "delete_success", id });
        if (id === activeSessionRef.current) {
          assistantRuntime?.thread.cancelRun();
          void resetFreshThread();
          clearRestoredBaseMessages();
          activeSessionRef.current = null;
          lastSyncedRef.current = null;
        }
      } catch (e) {
        if (signal.aborted || generation !== generationRef.current) return;
        dispatch({ type: "restore_error", error: e instanceof Error ? e.message : String(e) });
      }
    },
    [assistantRuntime, nextGeneration, resetFreshThread]
  );

  const appendPrompt = useCallback(
    (prompt: string) => {
      aui.thread().append(prompt);
    },
    [aui]
  );

  const activeSession =
    state.sessions.find((session) => session.id === state.activeSessionId) ?? null;

  return {
    ...state,
    activeSession,
    refreshSessions,
    startNew,
    selectSession,
    removeSession,
    appendPrompt,
    saveNow,
  };
}
