/**
 * 个性化偏好（REQ-110/112）：服务端按用户保存，跨设备生效。
 *
 * 契约：`GET /api/preferences` 返回**差异**（未设置过的用户是 `{}`），
 * 本地与内置默认值合并后再用；保存时整体覆盖式写入。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "../api";
import { DEFAULT_PREFERENCES, type UserPreferences } from "../types";
import {
  allCommands,
  defaultBindings,
  resolveBindings,
  validateKeySpec,
  type CommandDef,
  type ShortcutContext,
} from "../lib/shortcuts";

export interface UsePreferencesResult {
  prefs: UserPreferences;
  /** 命令 ID → 生效键位串（默认值 + 用户覆盖 + 解绑）。 */
  bindings: Record<string, string>;
  commands: CommandDef[];
  loading: boolean;
  saving: boolean;
  error: string | null;
  /** 本地合并（不落库），由设置面板攒够改动后调用 `save()`。 */
  update: (patch: Partial<UserPreferences>) => void;
  setKey: (commandId: string, spec: string) => { ok: boolean; error?: string };
  resetShortcuts: () => void;
  save: () => Promise<boolean>;
  reload: () => Promise<void>;
  dismissError: () => void;
}

function mergePrefs(remote: Partial<UserPreferences> | null): UserPreferences {
  const incoming = remote || {};
  return {
    shortcuts: { ...(incoming.shortcuts || {}) },
    fillColors:
      Array.isArray(incoming.fillColors) && incoming.fillColors.length
        ? [...incoming.fillColors]
        : [...DEFAULT_PREFERENCES.fillColors],
    highlightColors:
      Array.isArray(incoming.highlightColors) && incoming.highlightColors.length
        ? [...incoming.highlightColors]
        : [...DEFAULT_PREFERENCES.highlightColors],
    enterDirection: incoming.enterDirection || DEFAULT_PREFERENCES.enterDirection,
  };
}

export function usePreferences(enabled: boolean, onNotify?: (message: string) => void): UsePreferencesResult {
  const [prefs, setPrefs] = useState<UserPreferences>(() => mergePrefs(null));
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadedRef = useRef(false);

  const reload = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    try {
      const remote = await api.getPreferences();
      setPrefs(mergePrefs(remote));
      setError(null);
      loadedRef.current = true;
    } catch (err) {
      // 偏好读取失败不该挡住编辑：退回默认值并提示。
      setError(err instanceof Error ? err.message : "个性化设置读取失败");
      setPrefs(mergePrefs(null));
    } finally {
      setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      loadedRef.current = false;
      setPrefs(mergePrefs(null));
      return;
    }
    void reload();
  }, [enabled, reload]);

  const ctx: ShortcutContext = useMemo(
    () => ({ fillColors: prefs.fillColors, highlightColors: prefs.highlightColors }),
    [prefs.fillColors, prefs.highlightColors],
  );
  const commands = useMemo(() => allCommands(ctx), [ctx]);
  const bindings = useMemo(() => resolveBindings(ctx, prefs.shortcuts), [ctx, prefs.shortcuts]);

  const update = useCallback((patch: Partial<UserPreferences>) => {
    setPrefs((prev) => ({ ...prev, ...patch }));
  }, []);

  const setKey = useCallback(
    (commandId: string, spec: string) => {
      const verdict = validateKeySpec(spec);
      if (!verdict.ok) return { ok: false, error: verdict.error };
      setPrefs((prev) => {
        const shortcuts = { ...prev.shortcuts };
        if (!spec || spec === defaultBindings(ctx)[commandId]) {
          delete shortcuts[commandId]; // 与默认一致就不必存差异
        } else {
          shortcuts[commandId] = spec;
        }
        return { ...prev, shortcuts };
      });
      return { ok: true };
    },
    [ctx],
  );

  const resetShortcuts = useCallback(() => {
    setPrefs((prev) => ({ ...prev, shortcuts: {} }));
  }, []);

  const save = useCallback(async () => {
    setSaving(true);
    try {
      const saved = await api.savePreferences(prefs);
      setPrefs(mergePrefs(saved));
      setError(null);
      onNotify?.("个性化设置已保存");
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : "保存失败";
      setError(message);
      onNotify?.(message);
      return false;
    } finally {
      setSaving(false);
    }
  }, [prefs, onNotify]);

  return {
    prefs,
    bindings,
    commands,
    loading,
    saving,
    error,
    update,
    setKey,
    resetShortcuts,
    save,
    reload,
    dismissError: () => setError(null),
  };
}
