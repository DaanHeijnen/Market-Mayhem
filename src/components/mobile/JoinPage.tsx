import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../../lib/api';

export function JoinPage() {
  const { token } = useParams();
  const navigate = useNavigate();
  const [message, setMessage] = useState('Joining Market Mayhem…');
  const exchanged = useRef(false);

  useEffect(() => {
    if (exchanged.current) return;
    exchanged.current = true;

    void api<{ gameId: number }>('/api/join-player', {
      method: 'POST',
      body: JSON.stringify({ token }),
    })
      .then((result) => navigate(`/play/${result.gameId}`, { replace: true }))
      .catch((error: unknown) => {
        setMessage(error instanceof Error ? error.message : 'Could not join the game');
      });
  }, [navigate, token]);

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: '#DFF24C' }}>
      <h1 className="display">{message}</h1>
    </div>
  );
}
