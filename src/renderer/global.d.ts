import type { WorkbenchAPI } from '../shared/workbench-types'

declare global { interface Window { canvas: WorkbenchAPI } }
export {}
