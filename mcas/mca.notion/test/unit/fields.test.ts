import { describe, expect, it } from 'bun:test';
import {
  BLOCK_COMPACT_FIELDS,
  BLOCK_DETAIL_FIELDS,
  COMMENT_FIELDS,
  DATABASE_COMPACT_FIELDS,
  DATABASE_DETAIL_FIELDS,
  PAGE_COMPACT_FIELDS,
  PAGE_DETAIL_FIELDS,
  SEARCH_RESULT_FIELDS,
  USER_FIELDS,
} from '../../src/tools/_fields';

// Regression: the renderer falls back to initials / placeholders when visual
// fields are missing from the whitelist. These asserts catch accidental
// narrowing.

describe('_fields whitelists', () => {
  it('PAGE_COMPACT_FIELDS keeps visual fields', () => {
    expect(PAGE_COMPACT_FIELDS).toContain('icon');
    expect(PAGE_COMPACT_FIELDS).toContain('cover');
    expect(PAGE_COMPACT_FIELDS).toContain('url');
    expect(PAGE_COMPACT_FIELDS).toContain('title');
  });

  it('PAGE_DETAIL_FIELDS extends compact + properties', () => {
    for (const key of PAGE_COMPACT_FIELDS) {
      expect(PAGE_DETAIL_FIELDS).toContain(key);
    }
    expect(PAGE_DETAIL_FIELDS).toContain('properties');
  });

  it('DATABASE_COMPACT_FIELDS keeps visual fields', () => {
    expect(DATABASE_COMPACT_FIELDS).toContain('icon');
    expect(DATABASE_COMPACT_FIELDS).toContain('cover');
    expect(DATABASE_COMPACT_FIELDS).toContain('url');
    expect(DATABASE_COMPACT_FIELDS).toContain('title');
    expect(DATABASE_COMPACT_FIELDS).toContain('description');
  });

  it('DATABASE_DETAIL_FIELDS extends compact + schema', () => {
    for (const key of DATABASE_COMPACT_FIELDS) {
      expect(DATABASE_DETAIL_FIELDS).toContain(key);
    }
    expect(DATABASE_DETAIL_FIELDS).toContain('schema');
  });

  it('BLOCK_COMPACT_FIELDS includes type and timestamps', () => {
    expect(BLOCK_COMPACT_FIELDS).toContain('id');
    expect(BLOCK_COMPACT_FIELDS).toContain('type');
    expect(BLOCK_COMPACT_FIELDS).toContain('hasChildren');
    expect(BLOCK_COMPACT_FIELDS).toContain('createdTime');
  });

  it('BLOCK_DETAIL_FIELDS adds plainText + language + checked', () => {
    expect(BLOCK_DETAIL_FIELDS).toContain('plainText');
    expect(BLOCK_DETAIL_FIELDS).toContain('language');
    expect(BLOCK_DETAIL_FIELDS).toContain('checked');
  });

  it('USER_FIELDS keeps avatarUrl', () => {
    expect(USER_FIELDS).toContain('id');
    expect(USER_FIELDS).toContain('name');
    expect(USER_FIELDS).toContain('avatarUrl');
  });

  it('COMMENT_FIELDS collapses rich_text to plainText', () => {
    expect(COMMENT_FIELDS).toContain('plainText');
    expect(COMMENT_FIELDS).not.toContain('rich_text');
  });

  it('SEARCH_RESULT_FIELDS covers both page and database visuals', () => {
    expect(SEARCH_RESULT_FIELDS).toContain('icon');
    expect(SEARCH_RESULT_FIELDS).toContain('cover');
    expect(SEARCH_RESULT_FIELDS).toContain('object');
    expect(SEARCH_RESULT_FIELDS).toContain('url');
  });
});
