/**
 * 评论与 @提醒状态（REQ-100）。
 *
 * 与单元格数据分开管理：评论是"讨论"而非表格数据，因此不进入操作日志与版本链，
 * 但有独立的权限校验（commenter 及以上可写）与 WebSocket 广播（``comment_added``）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "../api";
import type { SheetComment } from "../api";

export interface UseCommentsResult {
  comments: SheetComment[];
  counts: Record<string, number>;
  members: Array<{ username: string; role: string }>;
  loading: boolean;
  error: string | null;
  /** 当前表格的未解决评论总数（用于工具栏徽标）。 */
  openCount: number;
  reload: () => Promise<void>;
  add: (rowId: string, colId: string, body: string) => Promise<boolean>;
  resolve: (commentId: number, resolved: boolean) => Promise<void>;
  remove: (commentId: number) => Promise<void>;
  /** 收到服务端广播时合并（WebSocket）。 */
  applyRemote: (comment: SheetComment, counts: Record<string, number>) => void;
  clearError: () => void;
}

export function useComments(sheetId: string | null): UseCommentsResult {
  const [comments, setComments] = useState<SheetComment[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [members, setMembers] = useState<Array<{ username: string; role: string }>>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sheetRef = useRef<string | null>(null);

  const reload = useCallback(async () => {
    const target = sheetId;
    if (!target) {
      setComments([]);
      setCounts({});
      setMembers([]);
      return;
    }
    try {
      setLoading(true);
      const payload = await api.listComments(target);
      // 请求返回时可能已切换表格：丢弃过期结果
      if (sheetRef.current !== target) return;
      setComments(payload.comments);
      setCounts(payload.counts);
      setMembers(payload.members);
      setError(null);
    } catch (err) {
      setError(String((err as Error).message ?? err));
    } finally {
      setLoading(false);
    }
  }, [sheetId]);

  useEffect(() => {
    sheetRef.current = sheetId;
    void reload();
  }, [sheetId, reload]);

  const add = useCallback(
    async (rowId: string, colId: string, body: string) => {
      if (!sheetId) return false;
      try {
        const result = await api.createComment(sheetId, rowId, colId, body);
        setComments((prev) => (prev.some((c) => c.id === result.comment.id) ? prev : [...prev, result.comment]));
        setCounts(result.counts);
        setError(null);
        return true;
      } catch (err) {
        setError(String((err as Error).message ?? err));
        return false;
      }
    },
    [sheetId],
  );

  const resolve = useCallback(
    async (commentId: number, resolved: boolean) => {
      if (!sheetId) return;
      try {
        const result = await api.resolveComment(sheetId, commentId, resolved);
        setComments((prev) => prev.map((c) => (c.id === commentId ? result.comment : c)));
        setCounts(result.counts);
      } catch (err) {
        setError(String((err as Error).message ?? err));
      }
    },
    [sheetId],
  );

  const remove = useCallback(
    async (commentId: number) => {
      if (!sheetId) return;
      try {
        const result = await api.deleteComment(sheetId, commentId);
        setComments((prev) => prev.filter((c) => c.id !== commentId));
        setCounts(result.counts);
      } catch (err) {
        setError(String((err as Error).message ?? err));
      }
    },
    [sheetId],
  );

  const applyRemote = useCallback((comment: SheetComment, nextCounts: Record<string, number>) => {
    // 新增或更新（解决/重开）都走这里：按 id 合并，缺失则追加
    setComments((prev) => {
      const index = prev.findIndex((c) => c.id === comment.id);
      if (index < 0) return [...prev, comment];
      const next = [...prev];
      next[index] = comment;
      return next;
    });
    setCounts(nextCounts);
  }, []);

  const clearError = useCallback(() => setError(null), []);

  const openCount = useMemo(() => comments.filter((c) => !c.resolved).length, [comments]);

  return {
    comments,
    counts,
    members,
    loading,
    error,
    openCount,
    reload,
    add,
    resolve,
    remove,
    applyRemote,
    clearError,
  };
}
