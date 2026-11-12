/**
 * Google Contacts Renderer - Index
 */

// Contact operations
export {
  CreateContactRenderer,
  DeleteContactRenderer,
  GetContactRenderer,
  ListContactsRenderer,
  SearchContactsRenderer,
  UpdateContactRenderer,
} from './ContactsRenderer';
// Contact group operations + health check
export {
  AddContactsToGroupRenderer,
  CreateContactGroupRenderer,
  DeleteContactGroupRenderer,
  GetContactGroupRenderer,
  ListContactGroupsRenderer,
  RemoveContactsFromGroupRenderer,
  UpdateContactGroupRenderer,
} from './ContactGroupsRenderer';
export { HealthCheckRenderer } from './HealthCheckRenderer';
// Shared
export * from './shared';
