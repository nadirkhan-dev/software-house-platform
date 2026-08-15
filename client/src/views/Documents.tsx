import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, upload, ApiError } from '../lib/api';
import { useSession } from '../lib/session';
import { Card, Confirm, Empty, ErrorState, Skeleton, Table } from '../components/ui';
import { useToast } from '../lib/toast';
import { bytes, dayLabel } from '../lib/format';
import { Modal } from '../components/ui';
import type { DocumentRow, Project } from '../lib/types';

/**
 * Documents.
 *
 * Every file hangs off exactly one thing — a project, client, invoice, quote,
 * task or milestone — which is what makes access control decidable rather than
 * a guess. `client_visible` is off by default: a document that reaches a client
 * by accident is a document that leaked.
 */
export function Documents() {
  const { perms } = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [project, setProject] = useState('');
  const [visible, setVisible] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<DocumentRow | null>(null);
  const [preview, setPreview] = useState<DocumentRow | null>(null);
  const [dragging, setDragging] = useState(false);

  const docs = useQuery({ queryKey: ['documents'], queryFn: () => api<{ documents: DocumentRow[] }>('/documents') });
  const projects = useQuery({
    queryKey: ['projects'], queryFn: () => api<{ projects: Project[] }>('/projects'),
    enabled: !perms?.isClient,
  });

  const send = useMutation({
    mutationFn: (file: File) => {
      if (!project) throw new ApiError('Choose a project to attach it to first', 400);
      return upload('project_id', project, file, visible);
    },
    onSuccess: () => { toast('Uploaded'); void qc.invalidateQueries({ queryKey: ['documents'] }); },
    onError: (e: ApiError) => toast(e.message, 'bad'),
  });

  const toggle = useMutation({
    mutationFn: (d: DocumentRow) =>
      api(`/documents/${d.id}`, { method: 'PATCH', body: { client_visible: !d.client_visible } }),
    onSuccess: (_r, d) => {
      toast(d.client_visible ? 'Hidden from the client' : 'Shared with the client');
      void qc.invalidateQueries({ queryKey: ['documents'] });
    },
    onError: (e: ApiError) => toast(e.message, 'bad'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api(`/documents/${id}`, { method: 'DELETE' }),
    onSuccess: () => { toast('Deleted'); setConfirmDelete(null); void qc.invalidateQueries({ queryKey: ['documents'] }); },
    onError: (e: ApiError) => toast(e.message, 'bad'),
  });

  if (docs.error) return <ErrorState error={docs.error as Error} />;

  return (
    <>
      <div className="head"><div>
        <div className="eyebrow">Files</div><h1>Documents</h1>
        <div className="sub">
          {perms?.isClient
            ? 'Files your agency has shared with you.'
            : 'Attach files to a project. Nothing is visible to a client until you share it.'}
        </div>
      </div></div>

      {!perms?.isClient && (
        <Card className="mb">
          <div className="pad">
            <div className="uploadrow">
              <select value={project} onChange={e => setProject(e.target.value)} aria-label="Project">
                <option value="">Choose a project…</option>
                {projects.data?.projects.map(p => <option key={p.project_id} value={p.project_id}>{p.name}</option>)}
              </select>
              <label className="checkline">
                <input type="checkbox" checked={visible} onChange={e => setVisible(e.target.checked)} />
                Share with the client
              </label>
              <button className="btn pri" disabled={!project || send.isPending}
                onClick={() => fileRef.current?.click()}>
                {send.isPending ? 'Uploading…' : 'Choose a file'}
              </button>
              <input ref={fileRef} type="file" hidden
                onChange={e => { const f = e.target.files?.[0]; if (f) send.mutate(f); e.target.value = ''; }} />
            </div>
            <div className={`dropzone ${dragging ? 'over' : ''}`}
              onDragOver={e => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={e => {
                e.preventDefault(); setDragging(false);
                const f = e.dataTransfer.files?.[0];
                if (!project) { toast('Choose a project first', 'bad'); return; }
                if (f) send.mutate(f);
              }}>
              Drop a file here — PDF, image, spreadsheet, document or archive, up to 25MB
            </div>
          </div>
        </Card>
      )}

      <Card title="Files" meta={docs.data ? `${docs.data.documents.length}` : undefined}>
        {docs.isLoading ? <Skeleton /> : !docs.data?.documents.length ? (
          <Empty title="No documents yet.">
            {perms?.isClient ? 'Anything your agency shares will appear here.' : 'Upload a contract, spec or deliverable above.'}
          </Empty>
        ) : (
          <Table head={<tr>
            <th>File</th><th>Size</th><th>Uploaded</th>
            {!perms?.isClient && <th>Client</th>}<th /></tr>}>
            {docs.data.documents.map(d => (
              <tr key={d.id}>
                <td><div className="pname">{d.filename}</div>
                  <div className="pclient">{d.content_type ?? 'file'}{d.uploaded_by ? ` · ${d.uploaded_by}` : ''}</div></td>
                <td className="num">{bytes(d.byte_size)}</td>
                <td className="num">{dayLabel(d.created_at)}</td>
                {!perms?.isClient && (
                  <td>
                    <button className={`chip ${d.client_visible ? 'good' : 'flat'}`}
                      onClick={() => toggle.mutate(d)}
                      title={d.client_visible ? 'Visible to the client — click to hide' : 'Internal — click to share'}>
                      {d.client_visible ? 'shared' : 'internal'}
                    </button>
                  </td>
                )}
                <td className="r nowrap">
                  {d.previewable && (
                    <button className="btn tiny" onClick={() => setPreview(d)}>Preview</button>
                  )}
                  <a className="btn tiny" href={`/api/documents/${d.id}/download`}>Download</a>
                  {!perms?.isClient && (
                    <button className="btn tiny" onClick={() => setConfirmDelete(d)}>Delete</button>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {preview && <PreviewModal doc={preview} onClose={() => setPreview(null)} />}

      {confirmDelete && (
        <Confirm title="Delete this document?" danger confirmLabel="Delete"
          body={<>Remove <b>{confirmDelete.filename}</b>? It stops appearing everywhere, including
            for the client if it was shared.</>}
          onConfirm={() => remove.mutate(confirmDelete.id)}
          onClose={() => setConfirmDelete(null)} />
      )}
    </>
  );
}

/**
 * Preview.
 *
 * The file is rendered in a sandboxed iframe pointed at an endpoint that only
 * serves types which cannot execute — PDFs, raster images and plain text. SVG
 * and HTML are excluded server-side and download instead; served inline from
 * our own origin they would run script against a logged-in session.
 */
function PreviewModal({ doc, onClose }: { doc: DocumentRow; onClose: () => void }) {
  const isImage = (doc.content_type ?? '').startsWith('image/');
  return (
    <Modal title={doc.filename} meta={doc.content_type ?? undefined} onClose={onClose} wide>
      <div className="previewbody">
        {isImage
          ? <img src={`/api/documents/${doc.id}/preview`} alt={doc.filename} />
          : <iframe src={`/api/documents/${doc.id}/preview`} title={doc.filename}
              sandbox="" referrerPolicy="no-referrer" />}
      </div>
      <div className="pad">
        <div className="modal-act">
          <a className="btn" href={`/api/documents/${doc.id}/download`}>Download</a>
          <button className="btn pri" onClick={onClose}>Close</button>
        </div>
      </div>
    </Modal>
  );
}
