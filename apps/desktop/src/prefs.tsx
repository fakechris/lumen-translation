import './http-bridge';
import './styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { PreferencesWindow } from './PreferencesWindow';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PreferencesWindow />
  </StrictMode>,
);
