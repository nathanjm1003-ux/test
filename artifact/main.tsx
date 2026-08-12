import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../src/index.css';
import { ArtifactApp } from './ArtifactApp';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ArtifactApp />
  </StrictMode>,
);
