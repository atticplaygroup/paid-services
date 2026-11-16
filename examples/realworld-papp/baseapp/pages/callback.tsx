import { useEffect, useState } from 'react';
import { callback } from '../adapters/oidc';
export default function Callback() {
  const [message, setMessage] = useState('Signing in…');
  useEffect(() => { callback().catch(error => setMessage(error.message)); }, []);
  return <p role="status">{message}</p>;
}
