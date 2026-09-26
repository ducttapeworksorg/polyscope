import '@fontsource-variable/atkinson-hyperlegible-next'
import '@fontsource-variable/red-hat-mono'
import './styles/app.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
