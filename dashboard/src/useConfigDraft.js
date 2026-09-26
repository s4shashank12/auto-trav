import { useEffect, useMemo, useState } from 'react';
import {
  getPath, sameJson, setPath, unsetPath,
} from './util.js';

// A server's settings being edited, shared by every settings screen so changes can be made on
// several tabs and saved together. Only values that differ from the defaults are kept (as
// overrides), so future default changes still reach settings nobody touched.
export function useConfigDraft(client, server, defaults, onSaved) {
  const saved = server?.config ?? {};
  // `base` is the saved config the edits started from; the draft is dirty when it differs.
  const [base, setBase] = useState(saved);
  const [draft, setDraft] = useState(saved);
  const [status, setStatus] = useState({ busy: false, error: null, message: null });
  const dirty = !sameJson(draft, base);

  // Follow the server (it is polled, and loads after the first render) while nothing is edited.
  useEffect(() => {
    if (sameJson(draft, base)) {
      setBase(saved);
      setDraft(saved);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(saved)]);

  return useMemo(() => {
    const value = (path) => {
      const own = getPath(draft, path);
      return own !== undefined ? own : getPath(defaults, path);
    };
    const isChanged = (path) => getPath(draft, path) !== undefined && !sameJson(getPath(draft, path), getPath(defaults, path));
    const change = (path, next) => {
      setStatus((s) => ({ ...s, message: null }));
      setDraft((d) => (sameJson(next, getPath(defaults, path)) ? unsetPath(d, path) : setPath(d, path, next)));
    };
    const reset = (path) => change(path, getPath(defaults, path));
    const replace = (next) => setDraft(next ?? {});
    const discard = () => {
      setBase(saved);
      setDraft(saved);
      setStatus({ busy: false, error: null, message: null });
    };
    const save = async (body = draft) => {
      setStatus({ busy: true, error: null, message: null });
      try {
        const updated = await client.updateServer(server.id, { config: body });
        setBase(updated.config ?? {});
        setDraft(updated.config ?? {});
        setStatus({ busy: false, error: null, message: 'Saved. Changes apply from the next round.' });
        onSaved?.();
        return true;
      } catch (err) {
        setStatus({ busy: false, error: err.message, message: null });
        return false;
      }
    };
    return {
      draft, dirty, status, value, isChanged, change, reset, replace, discard, save, defaults,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, base, dirty, status, defaults, client, server?.id, JSON.stringify(saved)]);
}
