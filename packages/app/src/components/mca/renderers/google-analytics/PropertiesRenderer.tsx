/**
 * GA4 Renderer — Properties. list, get, create, update, delete.
 */

import { Activity, Trash2 } from '@tamagui/lucide-icons';
import { ScrollView, Text, YStack } from 'tamagui';

import {
  colors as globalColors,
  Empty,
  EntityRow,
  ErrorBlock,
  IconChip,
  IconTile,
  KeyValueGrid,
  type KeyValueRow,
  parseOutput,
  ResourceCard,
  Specsheet,
  type SpecsheetSection,
  useColors,
} from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import {
  GA_BRAND,
  type GAProperty,
  formatDate,
  GoogleAnalyticsToolShell,
  propertyTypeChipProps,
  serviceLevelChipProps,
  useScrollStyle,
} from './shared';

// ============================================================================
// Helpers
// ============================================================================

function propertyRows(p: GAProperty): KeyValueRow[] {
  const rows: KeyValueRow[] = [];
  if (p.propertyId) rows.push({ key: 'id', value: p.propertyId });
  if (p.timeZone) rows.push({ key: 'timezone', value: p.timeZone });
  if (p.currencyCode) rows.push({ key: 'currency', value: p.currencyCode });
  if (p.industryCategory) {
    rows.push({ key: 'industry', value: p.industryCategory.toLowerCase().replace(/_/g, ' ') });
  }
  if (p.parent) rows.push({ key: 'account', value: p.parent });
  if (p.createTime) rows.push({ key: 'created', value: formatDate(p.createTime) });
  if (p.updateTime) rows.push({ key: 'updated', value: formatDate(p.updateTime) });
  return rows;
}

/**
 * Property detail as 4-section `Specsheet` — groups the flat field set by
 * semantic domain (identity / locale / industry / timeline). Users land on
 * the section they need without scanning a 7-row flat list.
 */
function propertySections(p: GAProperty): SpecsheetSection[] {
  const out: SpecsheetSection[] = [];
  const identity: SpecsheetSection['rows'] = [];
  if (p.propertyId) identity.push({ key: 'propertyId', value: p.propertyId });
  if (p.displayName) identity.push({ key: 'displayName', value: p.displayName });
  if (p.parent) identity.push({ key: 'account', value: p.parent });
  if (identity.length > 0) out.push({ title: 'Identity', rows: identity });

  const locale: SpecsheetSection['rows'] = [];
  if (p.timeZone) locale.push({ key: 'timezone', value: p.timeZone });
  if (p.currencyCode) locale.push({ key: 'currency', value: p.currencyCode });
  if (locale.length > 0) out.push({ title: 'Locale', rows: locale });

  const industry: SpecsheetSection['rows'] = [];
  if (p.industryCategory) {
    industry.push({ key: 'category', value: p.industryCategory.toLowerCase().replace(/_/g, ' ') });
  }
  if (p.propertyType) industry.push({ key: 'type', value: p.propertyType });
  if (p.serviceLevel) industry.push({ key: 'service', value: p.serviceLevel });
  if (industry.length > 0) out.push({ title: 'Industry', rows: industry });

  const timeline: SpecsheetSection['rows'] = [];
  if (p.createTime) timeline.push({ key: 'created', value: formatDate(p.createTime) });
  if (p.updateTime) timeline.push({ key: 'updated', value: formatDate(p.updateTime) });
  if (timeline.length > 0) out.push({ title: 'Timeline', rows: timeline });

  return out;
}

function PropertyMeta({ property }: { property: GAProperty }) {
  const typeChip = propertyTypeChipProps(property.propertyType);
  const serviceChip = serviceLevelChipProps(property.serviceLevel);
  if (!typeChip && !serviceChip) return null;
  return (
    <>
      {typeChip && <IconChip text={typeChip.text} accent={typeChip.accent} />}
      {serviceChip && <IconChip text={serviceChip.text} accent={serviceChip.accent} />}
    </>
  );
}

const propertyTile = (
  <IconTile
    accent={GA_BRAND.orange}
    icon={<Activity size={14} color={GA_BRAND.orange} />}
    size={26}
  />
);

// ============================================================================
// List Properties
// ============================================================================

interface ListPropertiesOutput {
  account?: string;
  count: number;
  properties: GAProperty[];
  nextPageToken?: string;
}

export function ListPropertiesRenderer({
  toolName,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const c = useColors();
  const raw = output ? parseOutput(output) : null;
  const parsed: ListPropertiesOutput | null =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as ListPropertiesOutput) : null;
  const properties = parsed?.properties ?? [];
  const scrollStyle = useScrollStyle(360);

  return (
    <GoogleAnalyticsToolShell
      toolName={toolName}
      status={status}
      duration={duration}
      description={properties.length > 0 ? `${properties.length} properties` : undefined}
    >
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && properties.length === 0 && (
        <Empty message="No properties" />
      )}
      {!error && properties.length > 0 && (
        <ScrollView style={scrollStyle}>
          <YStack>
            {properties.map((p: GAProperty) => (
              <EntityRow
                key={p.propertyId ?? p.name}
                leading={propertyTile}
                title={p.displayName ?? p.name ?? '—'}
                subtitle={p.propertyId ? `properties/${p.propertyId}` : undefined}
                badges={<PropertyMeta property={p} />}
                meta={
                  <Text color={c.text3} fontSize={9}>
                    {p.timeZone ?? formatDate(p.createTime)}
                  </Text>
                }
              />
            ))}
          </YStack>
        </ScrollView>
      )}
      {!error && parsed?.nextPageToken && (
        <Text color={c.text3} fontSize={9} fontFamily="$mono">
          + more available (use pageToken to paginate)
        </Text>
      )}
    </GoogleAnalyticsToolShell>
  );
}

// ============================================================================
// Get Property (detail)
// ============================================================================

interface GetPropertyOutput {
  account?: string;
  property: GAProperty;
}

export function GetPropertyRenderer({
  toolName,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const raw = output ? parseOutput(output) : null;
  const parsed: GetPropertyOutput | null =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as GetPropertyOutput) : null;
  const property = parsed?.property;

  return (
    <GoogleAnalyticsToolShell
      toolName={toolName}
      status={status}
      duration={duration}
      description={property?.displayName}
      defaultExpanded={status === 'completed' && !!property}
    >
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && property && (
        <ResourceCard
          leading={propertyTile}
          title={property.displayName ?? '—'}
          subtitle={property.propertyId ? `properties/${property.propertyId}` : undefined}
          meta={<PropertyMeta property={property} />}
        >
          <Specsheet sections={propertySections(property)} />
        </ResourceCard>
      )}
    </GoogleAnalyticsToolShell>
  );
}

// ============================================================================
// Create Property
// ============================================================================

export function CreatePropertyRenderer({
  toolName,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const raw = output ? parseOutput(output) : null;
  const parsed: GetPropertyOutput | null =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as GetPropertyOutput) : null;
  const property = parsed?.property;

  return (
    <GoogleAnalyticsToolShell
      toolName={toolName}
      status={status}
      duration={duration}
      description={property?.displayName ? `Created: ${property.displayName}` : undefined}
      defaultExpanded={status === 'completed' && !!property}
    >
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && property && (
        <ResourceCard
          leading={propertyTile}
          title={property.displayName ?? '—'}
          subtitle={property.propertyId ? `properties/${property.propertyId}` : undefined}
          verb="created"
          meta={<PropertyMeta property={property} />}
        >
          <KeyValueGrid rows={propertyRows(property)} />
        </ResourceCard>
      )}
    </GoogleAnalyticsToolShell>
  );
}

// ============================================================================
// Update Property
// ============================================================================

interface UpdatePropertyOutput extends GetPropertyOutput {
  updatedFields?: string[];
}

export function UpdatePropertyRenderer({
  toolName,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const c = useColors();
  const raw = output ? parseOutput(output) : null;
  const parsed: UpdatePropertyOutput | null =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as UpdatePropertyOutput) : null;
  const property = parsed?.property;
  const updatedFields = parsed?.updatedFields ?? [];

  return (
    <GoogleAnalyticsToolShell
      toolName={toolName}
      status={status}
      duration={duration}
      description={property?.displayName ? `Updated: ${property.displayName}` : undefined}
      defaultExpanded={status === 'completed' && !!property}
    >
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && property && (
        <ResourceCard
          leading={propertyTile}
          title={property.displayName ?? '—'}
          subtitle={property.propertyId ? `properties/${property.propertyId}` : undefined}
          verb="updated"
          meta={<PropertyMeta property={property} />}
        >
          {updatedFields.length > 0 && (
            <Text color={c.text3} fontSize={9} fontFamily="$mono">
              fields: {updatedFields.join(', ')}
            </Text>
          )}
          <KeyValueGrid rows={propertyRows(property)} />
        </ResourceCard>
      )}
    </GoogleAnalyticsToolShell>
  );
}

// ============================================================================
// Delete Property (soft-delete, recoverable)
// ============================================================================

interface DeletePropertyOutput extends GetPropertyOutput {
  recoverable?: boolean;
  recoverableWindowDays?: number;
}

export function DeletePropertyRenderer({
  toolName,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const c = useColors();
  const raw = output ? parseOutput(output) : null;
  const parsed: DeletePropertyOutput | null =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as DeletePropertyOutput) : null;
  const property = parsed?.property;
  const recoverable = parsed?.recoverable ?? true;
  const recoverableWindowDays = parsed?.recoverableWindowDays ?? 7;

  return (
    <GoogleAnalyticsToolShell
      toolName={toolName}
      status={status}
      duration={duration}
      description={property?.displayName ? `Deleted: ${property.displayName}` : undefined}
      defaultExpanded={status === 'completed' && !!property}
    >
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && property && (
        <ResourceCard
          leading={
            <IconTile
              accent={globalColors.red}
              icon={<Trash2 size={14} color={globalColors.red} />}
              size={26}
            />
          }
          title={property.displayName ?? '—'}
          subtitle={property.propertyId ? `properties/${property.propertyId}` : undefined}
          verb="deleted"
        >
          {recoverable && (
            <Text color={c.text2} fontSize={10}>
              Soft-delete: recoverable for ~{recoverableWindowDays} days from the Google Analytics
              UI.
            </Text>
          )}
          <KeyValueGrid
            rows={[
              { key: 'deleted', value: formatDate(property.deleteTime) },
              ...(property.parent ? [{ key: 'account', value: property.parent }] : []),
            ]}
          />
        </ResourceCard>
      )}
    </GoogleAnalyticsToolShell>
  );
}
