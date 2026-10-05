import { useRef, useState } from 'react'
import type { AceStepStatus } from '../../shared/music-types'
import type { ApiConfiguration } from '../../shared/workbench-types'
import { messageOf } from '../useWorkspace'

/** Manual, read-only observation tied to the saved connection, not a global readiness flag. */
export function useAceStepModels(configuration?: ApiConfiguration) {
  const token = configuration ? `${configuration.updatedAt}:${configuration.local?.connectionId}` : ''
  const tokenRef = useRef(token); tokenRef.current = token
  const [result, setResult] = useState<{ token: string; status?: AceStepStatus; error?: string }>()
  const [checking, setChecking] = useState(false)
  const lock = useRef(false)
  async function refresh(): Promise<void> {
    if (lock.current || !configuration) return
    lock.current = true; setChecking(true)
    try {
      const status = await window.canvas.getAceStepModels()
      if (status.baseUrl !== configuration.local?.baseUrl || tokenRef.current !== token) return
      setResult({ token, status })
    } catch (e) { if (tokenRef.current === token) setResult({ token, error: messageOf(e) }) }
    finally { lock.current = false; setChecking(false) }
  }
  return { status: result?.token === token ? result.status : undefined, error: result?.token === token ? result.error : undefined, checking, refresh }
}
