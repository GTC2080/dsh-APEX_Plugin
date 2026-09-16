import { z } from 'zod'

/** Harness displays a bounded JSON Schema subset; Zod enforces the full input schema. */
function displayedSchema(schema) {
  const { $schema, minLength, maxLength, minItems, maxItems, minimum, maximum, pattern, ...value } = schema
  const limits = Object.entries({ minLength, maxLength, minItems, maxItems, minimum, maximum, pattern })
    .filter(([, limit]) => limit !== undefined).map(([key, limit]) => `${key}=${limit}`)
  if (limits.length) value.description = [value.description, `Constraints: ${limits.join(', ')}.`].filter(Boolean).join(' ')
  if (value.properties) value.properties = Object.fromEntries(Object.entries(value.properties).map(([key, child]) => [key, displayedSchema(child)]))
  if (value.items) value.items = displayedSchema(value.items)
  if (value.oneOf) value.oneOf = value.oneOf.map(displayedSchema)
  return value
}

/** Zod union children have relative paths; retain them instead of just "Invalid input". */
function* inputIssues(issues, prefix = []) {
  for (const issue of issues) {
    const path = [...prefix, ...issue.path]
    yield `${path.join('.') || 'arguments'}: ${issue.message}${issue.code === 'invalid_union' ? ' (union alternatives below)' : ''}`.slice(0, 512)
    if (issue.code === 'invalid_union') {
      // Show the nearest alternatives first, without selecting or accepting one.
      for (const branch of [...issue.errors].sort((a, b) => a.length - b.length)) {
        yield* inputIssues(branch, path)
      }
    }
  }
}

/** Register through the public tool registry; do not rewrite arguments, outcomes or cancellation. */
export function registerTool(ctx, definition) {
  const input = z.fromJSONSchema(definition.parameters)
  return ctx.tools.register({
    ...definition,
    description: definition.description + (input.safeParse({}).success
      ? ` PTC usage: await tools.${definition.name}({}); pass one JSON object even when no options are set.`
      : ''),
    parameters: displayedSchema(definition.parameters),
    output: { ...definition.output, schema: displayedSchema(definition.output.schema) },
    async execute(args, execution) {
      const parsed = input.safeParse(args)
      if (!parsed.success) {
        const messages = []
        for (const message of inputIssues(parsed.error.issues)) {
          messages.push(message)
          if (messages.length === 8) break
        }
        throw new Error(`${definition.name}: ${messages.join('; ')}`)
      }
      execution.signal?.throwIfAborted()
      return await definition.execute(parsed.data, execution)
    },
  })
}
