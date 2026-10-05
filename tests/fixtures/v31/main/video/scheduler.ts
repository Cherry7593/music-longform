import { AppError } from '../../../../../src/main/providers/http'

/** One local render/probe owner across legacy exports, previews and the batch queue. */
export class RenderScheduler {
  private owner?: symbol
  get busy(): boolean { return this.owner !== undefined }
  reserve(): () => void {
    if (this.owner) throw new AppError('已有视频任务、试听或素材检查正在处理，请等待结束或暂停后再操作')
    const owner = Symbol('render')
    this.owner = owner
    return () => { if (this.owner === owner) this.owner = undefined }
  }
}
