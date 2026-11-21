import { useLocation, useNavigate, useParams } from 'react-router-dom';
// Only the Next router methods used by upstream components are adapted.
const listeners = new Set<(...args: any[]) => void>();
const events = { on: (_: string, fn: any) => listeners.add(fn), off: (_: string, fn: any) => listeners.delete(fn) };
export function useRouter() {
  const location = useLocation(), navigate = useNavigate(), params = useParams();
  const go = async (url: any, replace = false) => {
    const target = typeof url === 'string' ? url : `${url.pathname ?? location.pathname}?${new URLSearchParams(url.query)}`;
    listeners.forEach(fn => fn(target));
    navigate(target, { replace });
    return true;
  };
  return { query: { ...Object.fromEntries(new URLSearchParams(location.search)), ...params }, pathname: location.pathname, asPath: location.pathname + location.search, isReady: true, push: (url: any) => go(url), replace: (url: any) => go(url, true), back: () => navigate(-1), events };
}
export type NextRouter = ReturnType<typeof useRouter>;
