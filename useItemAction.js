import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, newKey } from './api';
import { useToast } from './toast';

/**
 * Runs an action against a work item with an optional optimistic update.
 *
 * The UI reflects the change immediately; the server's answer always wins:
 *  - success  → cache replaced with the server's item (authoritative version)
 *  - conflict → optimistic state rolled back, fresh data fetched, user told why
 */
export function useItemAction(itemId) {
  const qc = useQueryClient();
  const toast = useToast();

  return useMutation({
    mutationFn: ({ method = 'POST', path, body, key }) => api.mutate(method, `/items/${itemId}${path}`, body, key),
    onMutate: async ({ optimistic }) => {
      await qc.cancelQueries({ queryKey: ['item', itemId] });
      const previous = qc.getQueryData(['item', itemId]);
      if (optimistic && previous) qc.setQueryData(['item', itemId], { item: optimistic(previous.item) });
      return { previous };
    },
    onError: (err, vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(['item', itemId], ctx.previous);
      qc.invalidateQueries({ queryKey: ['item', itemId] });
      if (vars.onError?.(err)) return;
      if (err.code === 'VERSION_CONFLICT') {
        const who = err.details?.changes?.at(-1)?.actor;
        toast(`${who || 'Someone'} changed this item a moment ago. You're now looking at the latest version.`, 'warn');
      } else {
        toast(err.message, 'error');
      }
    },
    onSuccess: (data, vars) => {
      if (data?.item) qc.setQueryData(['item', itemId], (old) => ({ ...old, item: data.item }));
      qc.invalidateQueries({ queryKey: ['activity', itemId] });
      qc.invalidateQueries({ queryKey: ['items'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      vars.onSuccess?.(data);
    },
  });
}

export { newKey };
