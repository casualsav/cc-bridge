// Compact model names shared by the pinned status card and Mini App composer.
// These are routing-family nicknames, not a model catalog: an unknown id stays byte-for-byte truthful.
export function codexPrettyModel(id: string): string {
  const family = id.match(/^gpt-[\d.]+-(sol|terra|luna)$/i)?.[1]
  return family ? family[0].toUpperCase() + family.slice(1).toLowerCase() : id
}

export function prettyModel(id: string | null): string | null {
  if (!id) return id
  const gpt = codexPrettyModel(id)
  if (gpt !== id) return gpt
  const m = id.match(/(opus|sonnet|haiku|fable)/i)
  return m ? m[1][0].toUpperCase() + m[1].slice(1).toLowerCase() : id
}
