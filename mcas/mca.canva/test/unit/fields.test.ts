import { describe, expect, it } from 'bun:test';
import {
  ASSET_COMPACT_FIELDS,
  ASSET_DETAIL_FIELDS,
  BRAND_TEMPLATE_COMPACT_FIELDS,
  BRAND_TEMPLATE_DETAIL_FIELDS,
  DESIGN_COMPACT_FIELDS,
  DESIGN_DETAIL_FIELDS,
  FOLDER_FIELDS,
  FOLDER_ITEM_FIELDS,
  JOB_FIELDS,
  REPLY_FIELDS,
  THREAD_FIELDS,
  USER_FIELDS,
} from '../../src/tools/_fields';

// Regression: the renderer falls back to placeholders when visual fields
// (thumbnailUrl, viewUrl, editUrl) are missing from the whitelist. These
// asserts catch accidental narrowing by future edits.
describe('_fields whitelists', () => {
  it('DESIGN_COMPACT_FIELDS keeps identity + thumbnail for polaroid preview', () => {
    expect(DESIGN_COMPACT_FIELDS).toContain('id');
    expect(DESIGN_COMPACT_FIELDS).toContain('title');
    expect(DESIGN_COMPACT_FIELDS).toContain('thumbnailUrl');
    expect(DESIGN_COMPACT_FIELDS).toContain('thumbnailWidth');
    expect(DESIGN_COMPACT_FIELDS).toContain('thumbnailHeight');
    expect(DESIGN_COMPACT_FIELDS).toContain('pageCount');
    expect(DESIGN_COMPACT_FIELDS).toContain('updatedAt');
  });

  it('DESIGN_DETAIL_FIELDS extends compact with owner + edit/view URLs', () => {
    for (const key of DESIGN_COMPACT_FIELDS) {
      expect(DESIGN_DETAIL_FIELDS).toContain(key);
    }
    expect(DESIGN_DETAIL_FIELDS).toContain('ownerUserId');
    expect(DESIGN_DETAIL_FIELDS).toContain('editUrl');
    expect(DESIGN_DETAIL_FIELDS).toContain('viewUrl');
  });

  it('FOLDER_FIELDS keeps thumbnail (folders can be image-rich)', () => {
    expect(FOLDER_FIELDS).toContain('id');
    expect(FOLDER_FIELDS).toContain('name');
    expect(FOLDER_FIELDS).toContain('thumbnailUrl');
  });

  it('FOLDER_ITEM_FIELDS exposes type so renderer can dispatch icons', () => {
    expect(FOLDER_ITEM_FIELDS).toContain('type');
    expect(FOLDER_ITEM_FIELDS).toContain('id');
    expect(FOLDER_ITEM_FIELDS).toContain('name');
    expect(FOLDER_ITEM_FIELDS).toContain('thumbnailUrl');
    expect(FOLDER_ITEM_FIELDS).toContain('pinStatus');
  });

  it('ASSET_COMPACT_FIELDS keeps type + thumbnail (image vs video distinction)', () => {
    expect(ASSET_COMPACT_FIELDS).toContain('id');
    expect(ASSET_COMPACT_FIELDS).toContain('name');
    expect(ASSET_COMPACT_FIELDS).toContain('type');
    expect(ASSET_COMPACT_FIELDS).toContain('thumbnailUrl');
  });

  it('ASSET_DETAIL_FIELDS adds tags + dimensions + metadata', () => {
    for (const key of ASSET_COMPACT_FIELDS) {
      expect(ASSET_DETAIL_FIELDS).toContain(key);
    }
    expect(ASSET_DETAIL_FIELDS).toContain('tags');
    expect(ASSET_DETAIL_FIELDS).toContain('thumbnailWidth');
    expect(ASSET_DETAIL_FIELDS).toContain('thumbnailHeight');
    expect(ASSET_DETAIL_FIELDS).toContain('metadata');
  });

  it('BRAND_TEMPLATE_COMPACT_FIELDS keeps thumbnail (templates ARE visual)', () => {
    expect(BRAND_TEMPLATE_COMPACT_FIELDS).toContain('id');
    expect(BRAND_TEMPLATE_COMPACT_FIELDS).toContain('title');
    expect(BRAND_TEMPLATE_COMPACT_FIELDS).toContain('thumbnailUrl');
  });

  it('BRAND_TEMPLATE_DETAIL_FIELDS adds viewUrl + createUrl', () => {
    for (const key of BRAND_TEMPLATE_COMPACT_FIELDS) {
      expect(BRAND_TEMPLATE_DETAIL_FIELDS).toContain(key);
    }
    expect(BRAND_TEMPLATE_DETAIL_FIELDS).toContain('viewUrl');
    expect(BRAND_TEMPLATE_DETAIL_FIELDS).toContain('createUrl');
  });

  it('JOB_FIELDS uniform across export/import/autofill/resize/asset upload', () => {
    expect(JOB_FIELDS).toContain('id');
    expect(JOB_FIELDS).toContain('status');
    expect(JOB_FIELDS).toContain('error');
    expect(JOB_FIELDS).toContain('result');
  });

  it('THREAD_FIELDS keeps designId + author + plaintext message', () => {
    expect(THREAD_FIELDS).toContain('id');
    expect(THREAD_FIELDS).toContain('designId');
    expect(THREAD_FIELDS).toContain('authorUserId');
    expect(THREAD_FIELDS).toContain('messagePlaintext');
    expect(THREAD_FIELDS).toContain('resolved');
  });

  it('REPLY_FIELDS keeps threadId for back-navigation', () => {
    expect(REPLY_FIELDS).toContain('id');
    expect(REPLY_FIELDS).toContain('threadId');
    expect(REPLY_FIELDS).toContain('authorUserId');
    expect(REPLY_FIELDS).toContain('messagePlaintext');
  });

  it('USER_FIELDS exposes both userId and teamId', () => {
    expect(USER_FIELDS).toContain('userId');
    expect(USER_FIELDS).toContain('teamId');
  });
});
