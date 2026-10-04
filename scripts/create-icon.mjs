import fs from 'node:fs/promises'
import sharp from 'sharp'
async function main() {
  const png = await sharp('build/icon.svg').png().toBuffer()
  await fs.writeFile('build/icon.png', png)
  const header = Buffer.alloc(22)
  header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4)
  header.writeUInt16LE(1, 10); header.writeUInt16LE(32, 12)
  header.writeUInt32LE(png.length, 14); header.writeUInt32LE(22, 18)
  await fs.writeFile('build/icon.ico', Buffer.concat([header, png]))
}
main().catch(error => { console.error(error); process.exitCode = 1 })
