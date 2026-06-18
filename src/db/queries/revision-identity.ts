import { RevisionAttributesSchema, RevisionDateSchema } from '../../ast/index.js';
import type { RevisionAttributes, RevisionNomenclatureType } from '../../ast/index.js';
import { DatabaseError } from '../errors.js';
import type { RevisionNomenclatureProfile } from './revision-nomenclature.js';

export class RevisionNomenclatureValidationError extends DatabaseError {}

export interface CreatePackageRevisionInput {
  readonly label?: string;
  readonly type?: string;
  readonly date?: string;
  readonly sortOrder?: number;
  readonly attributes?: RevisionAttributes;
}

export interface RevisionIdentityDraft {
  readonly label: string;
  readonly type: string;
  readonly date: string;
  readonly sortOrder?: number;
  readonly attributes: RevisionAttributes;
  readonly number: string | null;
}

export interface RevisionDisplayIdentity {
  readonly displayName: string;
  readonly number: string | null;
}

function scalarToString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function replaceTemplate(
  template: string,
  definition: RevisionNomenclatureType,
  attributes: RevisionAttributes,
  date: string
): string {
  const typeName = definition.name ?? definition.key;
  const values: Record<string, unknown> = { ...attributes, date, type: definition.key, typeName };
  return template.replace(/\{([A-Za-z0-9_.-]+)\}/g, (_match, key: string) => {
    const scalar = scalarToString(values[key]);
    return scalar ?? '';
  });
}

function displayTemplate(definition: RevisionNomenclatureType): string {
  if (definition.format?.displayName) return definition.format.displayName;
  if (definition.fields?.some((field) => field.key === 'number')) {
    return `${definition.name ?? definition.key} {number}`;
  }
  return '{title}';
}

function findType(
  profile: RevisionNomenclatureProfile,
  revisionType: string
): RevisionNomenclatureType {
  const definition = profile.types.find((type) => type.key === revisionType);
  if (!definition) {
    throw new RevisionNomenclatureValidationError(
      `revision type "${revisionType}" is not defined by the resolved nomenclature profile`
    );
  }
  return definition;
}

function isMissingRequired(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

function fieldKindValid(kind: string, value: unknown): boolean {
  if (kind === 'json') return true;
  if (kind === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (kind === 'number') return typeof value === 'number';
  if (kind === 'string') return typeof value === 'string';
  if (kind === 'date') return RevisionDateSchema.safeParse(value).success;
  if (kind === 'boolean') return typeof value === 'boolean';
  return true;
}

function validateField(
  field: NonNullable<RevisionNomenclatureType['fields']>[number],
  attributes: RevisionAttributes,
  revisionType: string
): void {
  const value = attributes[field.key];
  if (field.required && isMissingRequired(value)) {
    throw new RevisionNomenclatureValidationError(
      `revision type "${revisionType}" requires attribute "${field.key}"`
    );
  }
  if (!isMissingRequired(value) && field.kind && !fieldKindValid(field.kind, value)) {
    throw new RevisionNomenclatureValidationError(
      `attribute "${field.key}" does not match kind "${field.kind}"`
    );
  }
}

function validateAttributes(
  definition: RevisionNomenclatureType,
  attributes: RevisionAttributes
): RevisionAttributes {
  const parsed = RevisionAttributesSchema.parse(attributes);
  for (const field of definition.fields ?? []) validateField(field, parsed, definition.key);
  return parsed;
}

function legacyIdentity(label: string): RevisionIdentityDraft {
  const trimmed = label.trim();
  const numbered = /^(addendum|bulletin|ccd)\s+(\d+)$/i.exec(trimmed);
  if (numbered) {
    const type = numbered[1]?.toLowerCase() ?? 'issuance';
    const number = Number(numbered[2]);
    return { label, type, date: todayIsoDate(), attributes: { number }, number: String(number) };
  }
  return {
    label,
    type: 'issuance',
    date: todayIsoDate(),
    attributes: { title: label },
    number: null,
  };
}

function displayIdentity(
  definition: RevisionNomenclatureType,
  attributes: RevisionAttributes,
  date: string
): RevisionDisplayIdentity {
  const displayName = replaceTemplate(displayTemplate(definition), definition, attributes, date);
  const numberTemplate = definition.format?.number;
  const number = numberTemplate
    ? replaceTemplate(numberTemplate, definition, attributes, date)
    : scalarToString(attributes.number);
  return { displayName, number };
}

export function createRevisionIdentityDraft(
  input: string | CreatePackageRevisionInput,
  profile: RevisionNomenclatureProfile
): RevisionIdentityDraft {
  if (typeof input === 'string') return legacyIdentity(input);
  if (input.label !== undefined && input.type === undefined) return legacyIdentity(input.label);
  const revisionType = input.type;
  if (!revisionType) throw new RevisionNomenclatureValidationError('revision type is required');
  const definition = findType(profile, revisionType);
  const attributes = validateAttributes(definition, input.attributes ?? {});
  const date = input.date ?? todayIsoDate();
  const identity = displayIdentity(definition, attributes, date);
  const draft: RevisionIdentityDraft = {
    label: identity.displayName,
    type: definition.key,
    date,
    attributes,
    number: identity.number,
  };
  return {
    ...draft,
    ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
  };
}

export function getRevisionDisplayIdentity(
  revisionType: string,
  attributes: RevisionAttributes,
  profile: RevisionNomenclatureProfile | null,
  label: string,
  date: string
): RevisionDisplayIdentity {
  const definition = profile?.types.find((type) => type.key === revisionType);
  if (!definition) return { displayName: label, number: scalarToString(attributes.number) };
  return { displayName: label, number: displayIdentity(definition, attributes, date).number };
}
