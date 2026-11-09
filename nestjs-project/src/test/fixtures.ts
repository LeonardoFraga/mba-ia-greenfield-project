/**
 * Builds a partial entity fixture typed as the full entity.
 *
 * Specs rarely need every column of an entity, but `as any` silences the type
 * checker entirely — a renamed or misspelled column slips through unnoticed.
 * The literal here is still checked against the entity's shape; only the
 * "some columns are missing" part is waived.
 */
export function fixture<T>(partial: Partial<T>): T {
  return partial as unknown as T;
}
