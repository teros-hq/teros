import { describe, expect, it } from 'bun:test';
import {
  buildAssetShape,
  buildAssetUploadJobShape,
  buildAutofillJobShape,
  buildBrandTemplateShape,
  buildDesignPagesShape,
  buildDesignShape,
  buildExportFormatsShape,
  buildExportJobShape,
  buildFolderItemShape,
  buildFolderShape,
  buildImportJobShape,
  buildReplyShape,
  buildResizeJobShape,
  buildThreadShape,
  buildUserCapabilitiesShape,
  buildUserProfileShape,
  buildUserShape,
} from '../../src/lib/_canva-helpers';

describe('Canva shape builders', () => {
  it('buildDesignShape extracts owner + thumbnail + URLs', () => {
    const raw = {
      design: {
        id: 'DAF1',
        title: 'My poster',
        owner: { user_id: 'U1', team_id: 'T1' },
        urls: { edit_url: 'https://e', view_url: 'https://v' },
        thumbnail: { url: 'https://t', width: 400, height: 300 },
        page_count: 3,
        created_at: 1700000000,
        updated_at: 1800000000,
      },
    };
    const s = buildDesignShape(raw);
    expect(s.id).toBe('DAF1');
    expect(s.title).toBe('My poster');
    expect(s.ownerUserId).toBe('U1');
    expect(s.ownerTeamId).toBe('T1');
    expect(s.editUrl).toBe('https://e');
    expect(s.viewUrl).toBe('https://v');
    expect(s.thumbnailUrl).toBe('https://t');
    expect(s.thumbnailWidth).toBe(400);
    expect(s.thumbnailHeight).toBe(300);
    expect(s.pageCount).toBe(3);
  });

  it('buildDesignShape tolerates legacy flat shape (no design wrapper)', () => {
    const raw = { id: 'DAF1', title: 'Plain' };
    const s = buildDesignShape(raw);
    expect(s.id).toBe('DAF1');
    expect(s.title).toBe('Plain');
    expect(s.thumbnailUrl).toBeNull();
  });

  it('buildFolderShape returns nulls for missing fields', () => {
    const s = buildFolderShape({});
    expect(s.id).toBeNull();
    expect(s.name).toBeNull();
    expect(s.thumbnailUrl).toBeNull();
  });

  it('buildFolderItemShape unwraps design/folder/image variants', () => {
    const designItem = buildFolderItemShape({
      type: 'design',
      design: { id: 'D1', title: 'A', thumbnail: { url: 'https://x' } },
      pin_status: 'pinned',
    });
    expect(designItem.type).toBe('design');
    expect(designItem.id).toBe('D1');
    expect(designItem.name).toBe('A');
    expect(designItem.thumbnailUrl).toBe('https://x');
    expect(designItem.pinStatus).toBe('pinned');

    const folderItem = buildFolderItemShape({
      type: 'folder',
      folder: { id: 'F1', name: 'Inbox' },
    });
    expect(folderItem.type).toBe('folder');
    expect(folderItem.name).toBe('Inbox');
  });

  it('buildAssetShape includes tags + metadata', () => {
    const s = buildAssetShape({
      asset: {
        id: 'A1',
        name: 'cat.jpg',
        type: 'image',
        tags: ['cute', 'cat'],
        thumbnail: { url: 'https://thumb', width: 100, height: 80 },
        metadata: { mime_type: 'image/jpeg' },
      },
    });
    expect(s.id).toBe('A1');
    expect(s.type).toBe('image');
    expect(s.tags).toEqual(['cute', 'cat']);
    expect(s.metadata).toEqual({ mime_type: 'image/jpeg' });
    expect(s.thumbnailUrl).toBe('https://thumb');
  });

  it('buildAssetShape handles missing tags as empty array', () => {
    const s = buildAssetShape({ id: 'A1' });
    expect(s.tags).toEqual([]);
  });

  it('buildBrandTemplateShape extracts viewUrl + createUrl', () => {
    const s = buildBrandTemplateShape({
      brand_template: {
        id: 'BT1',
        title: 'Newsletter',
        thumbnail: { url: 'https://t' },
        view_url: 'https://v',
        create_url: 'https://c',
      },
    });
    expect(s.id).toBe('BT1');
    expect(s.viewUrl).toBe('https://v');
    expect(s.createUrl).toBe('https://c');
  });

  it('buildExportJobShape exposes urls when status=success', () => {
    const s = buildExportJobShape({
      job: { id: 'J1', status: 'success', urls: ['https://1', 'https://2'] },
    });
    expect(s.status).toBe('success');
    expect(s.result).toEqual({ urls: ['https://1', 'https://2'] });
  });

  it('buildExportJobShape preserves error on failure', () => {
    const s = buildExportJobShape({
      job: { id: 'J1', status: 'failed', error: { code: 'limit', message: 'over quota' } },
    });
    expect(s.status).toBe('failed');
    expect(s.error).toEqual({ code: 'limit', message: 'over quota' });
    expect(s.result).toBeNull();
  });

  it('buildImportJobShape extracts first design id', () => {
    const s = buildImportJobShape({
      job: { id: 'J1', status: 'success', result: { designs: [{ id: 'D1' }, { id: 'D2' }] } },
    });
    expect(s.result).toEqual({ designId: 'D1' });
  });

  it('buildAutofillJobShape includes nested design shape', () => {
    const s = buildAutofillJobShape({
      job: {
        id: 'J1',
        status: 'success',
        result: { design: { id: 'D1', title: 'Filled', thumbnail: { url: 'https://t' } } },
      },
    });
    expect(s.result?.id).toBe('D1');
    expect(s.result?.title).toBe('Filled');
    expect(s.result?.thumbnailUrl).toBe('https://t');
  });

  it('buildResizeJobShape mirrors autofill shape', () => {
    const s = buildResizeJobShape({
      job: { id: 'J1', status: 'success', result: { design: { id: 'D2' } } },
    });
    expect(s.result?.id).toBe('D2');
  });

  it('buildAssetUploadJobShape attaches asset on success', () => {
    const s = buildAssetUploadJobShape({
      job: { id: 'J1', status: 'success' },
      asset: { id: 'A1', name: 'logo.png', thumbnail: { url: 'https://t' } },
    });
    expect(s.result?.id).toBe('A1');
    expect(s.result?.thumbnailUrl).toBe('https://t');
  });

  it('buildThreadShape extracts plaintext from content or legacy field', () => {
    const a = buildThreadShape({
      thread: {
        id: 'T1',
        design_id: 'D1',
        author: { user_id: 'U1' },
        content: { plaintext: 'Hello' },
        resolved: false,
      },
    });
    expect(a.messagePlaintext).toBe('Hello');
    expect(a.designId).toBe('D1');
    expect(a.resolved).toBe(false);

    const b = buildThreadShape({ id: 'T1', message_plaintext: 'Legacy' });
    expect(b.messagePlaintext).toBe('Legacy');
  });

  it('buildReplyShape extracts threadId', () => {
    const s = buildReplyShape({
      reply: { id: 'R1', thread_id: 'T1', content: { plaintext: 'Hi' } },
    });
    expect(s.threadId).toBe('T1');
    expect(s.messagePlaintext).toBe('Hi');
  });

  it('buildUserShape tolerates wrapper or flat', () => {
    expect(buildUserShape({ team_user: { user_id: 'U1', team_id: 'T1' } })).toEqual({
      userId: 'U1',
      teamId: 'T1',
    });
    expect(buildUserShape({ user_id: 'U2', team_id: 'T2' })).toEqual({
      userId: 'U2',
      teamId: 'T2',
    });
  });

  it('buildUserProfileShape extracts displayName', () => {
    expect(buildUserProfileShape({ profile: { display_name: 'Antonio' } })).toEqual({
      displayName: 'Antonio',
    });
  });

  it('buildUserCapabilitiesShape returns empty array when missing', () => {
    expect(buildUserCapabilitiesShape({}).capabilities).toEqual([]);
    expect(buildUserCapabilitiesShape({ capabilities: ['enterprise'] }).capabilities).toEqual([
      'enterprise',
    ]);
  });

  it('buildDesignPagesShape preserves order + dimensions', () => {
    const s = buildDesignPagesShape({
      pages: [
        { thumbnail: { url: 'https://1', width: 800, height: 600 } },
        { thumbnail: { url: 'https://2', width: 800, height: 600 } },
      ],
    });
    expect(s.pages).toHaveLength(2);
    expect(s.pages[0].thumbnailUrl).toBe('https://1');
    expect(s.pages[0].width).toBe(800);
    expect(s.pages[0].index).toBe(0);
    expect(s.pages[1].index).toBe(1);
  });

  it('buildExportFormatsShape returns only supported formats', () => {
    const s = buildExportFormatsShape({
      formats: { pdf: {}, png: {}, jpg: {}, mp4: null },
    });
    expect(s.formats).toContain('pdf');
    expect(s.formats).toContain('png');
    expect(s.formats).toContain('jpg');
    expect(s.formats).not.toContain('mp4');
  });
});
