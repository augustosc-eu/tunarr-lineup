// Entry for the local companion build. It renders the same interface as the
// hosted Vinext app, without Next.js server features.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import Home from '../app/page';
import '../app/globals.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Home />
  </StrictMode>,
);
