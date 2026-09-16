// Trusted one-operation worker: native filesystem mechanics execute under the same kernel file policy as PTC.
const [{ Context }, { default: LocalFileSystem }] = await Promise.all(process.argv.slice(2, 4).map(path => import(path)))
const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)
const request = JSON.parse(Buffer.concat(chunks).toString('utf8'))
const ctx = new Context()
const fiber = ctx.plugin(LocalFileSystem, request.config)
await fiber.await()
let response
try {
  if (!['writeText', 'editText'].includes(request.method)) throw new Error('Unsupported filesystem mutation')
  const value = await ctx.fs[request.method](request.target, request.body, request.expected)
  response = { ok: true, value }
} catch (error) {
  response = { ok: false, code: error.code ?? 'FS_IO_ERROR', message: String(error.message).slice(0, 2048) }
} finally {
  await fiber.dispose()
}
process.stdout.write(JSON.stringify(response))
