// External, same-origin refresh setup keeps development compatible with script-src 'self'.
// The Vite React plugin turns this virtual module into an empty module in production.
import '@vitejs/plugin-react/preamble'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('找不到应用挂载节点')
createRoot(root).render(<StrictMode><App /></StrictMode>)
