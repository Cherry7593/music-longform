import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { CancelledError } from './ffmpeg'

/** Read only the local device/driver identity. Unknown identity deliberately disables hardware caching. */
export async function encoderDeviceIdentity(signal: AbortSignal): Promise<string | undefined> {
  if (signal.aborted) throw new CancelledError()
  if (process.platform !== 'win32') return undefined
  const executable = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const command = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $ErrorActionPreference="Stop"; @(Get-CimInstance Win32_VideoController -Property DeviceID,PNPDeviceID,DriverVersion,Status,ConfigManagerErrorCode | Sort-Object DeviceID | Select-Object DeviceID,PNPDeviceID,DriverVersion,Status,ConfigManagerErrorCode) | ConvertTo-Json -Compress'
  const output = await new Promise<string | undefined>(resolve => {
    execFile(executable, ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, signal, timeout: 5000, maxBuffer: 64 * 1024, encoding: 'utf8' }, (error, stdout) => resolve(error ? undefined : stdout))
  })
  if (signal.aborted) throw new CancelledError()
  if (!output) return undefined
  try {
    const parsed: unknown = JSON.parse(output.replace(/^\uFEFF/, '').trim()), rows = Array.isArray(parsed) ? parsed : [parsed]
    if (!rows.length || rows.length > 32 || rows.some(row => !row || typeof row !== 'object' || typeof row.DeviceID !== 'string' || typeof row.PNPDeviceID !== 'string' || typeof row.DriverVersion !== 'string')) return undefined
    return createHash('sha256').update(JSON.stringify(rows)).digest('hex')
  } catch { return undefined }
}
