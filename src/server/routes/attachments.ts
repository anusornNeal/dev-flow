import fs from 'fs';
import path from 'path';
import multer from 'multer';
import crypto from 'crypto';
import type express from 'express';
import type { ApiRouteDeps } from '../types';
import { sendApiError, createApiError } from '../services/api';
import { getTaskUploadsDir, getDevFlowUploadsDir } from '../../lib/devFlowPaths';
import {
  createAttachment,
  getAttachment,
  listAttachmentsForTask,
  softDeleteAttachment,
  type AttachmentKind,
  type AttachmentRecord,
} from '../repositories/attachmentRepository';
import { findTaskByIdentifier } from '../services/taskService';
import { TaskImage } from '../../types';

const ALLOWED_MIME_PREFIXES = ['image/', 'application/pdf', 'text/'];
const ALLOWED_MIME_EXACT = new Set([
  'application/json',
  'application/zip',
  'application/octet-stream',
]);

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'file';
}

function detectKind(mimeType: string | undefined, originalName: string): AttachmentKind {
  if (mimeType?.startsWith('image/')) return 'image';
  const lower = originalName.toLowerCase();
  if (lower.endsWith('.pdf') || lower.endsWith('.md') || lower.endsWith('.txt')) return 'spec';
  if (lower.endsWith('.fig') || lower.endsWith('.sketch') || lower.endsWith('.xd')) return 'design';
  return 'file';
}

function isAllowedMime(mimeType: string | undefined): boolean {
  if (!mimeType) return true;
  if (ALLOWED_MIME_EXACT.has(mimeType)) return true;
  return ALLOWED_MIME_PREFIXES.some((p) => mimeType.startsWith(p));
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

function toRelativeFromUploads(absolutePath: string): string {
  const uploadsRoot = getDevFlowUploadsDir();
  const rel = path.relative(uploadsRoot, absolutePath).split(path.sep).join('/');
  return rel;
}

export function registerAttachmentRoutes(app: express.Express, deps: ApiRouteDeps) {
  // General Image Upload (not tied to taskId yet)
  app.post(
    '/api/images/upload',
    (req, res, next) => {
      upload.single('file')(req, res, (err: any) => {
        if (err) {
          return sendApiError(res, createApiError(400, 'UPLOAD_FAILED', err.message || 'Upload failed', { retryable: false }));
        }
        next();
      });
    },
    (req, res) => {
      try {
        const file = (req as any).file as Express.Multer.File | undefined;
        if (!file) {
          return sendApiError(res, createApiError(400, 'NO_FILE', 'No file uploaded under field "file"', { retryable: false }));
        }

        if (!isAllowedMime(file.mimetype)) {
          return sendApiError(
            res,
            createApiError(415, 'UNSUPPORTED_MEDIA_TYPE', `Mime type not allowed: ${file.mimetype}`, { retryable: false }),
          );
        }

        const imagesDir = path.join(getDevFlowUploadsDir(), 'images');
        fs.mkdirSync(imagesDir, { recursive: true });

        const imageId = `img-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
        const safeName = sanitizeFileName(file.originalname);
        const storedName = `${imageId}-${safeName}`;
        const absoluteFilePath = path.join(imagesDir, storedName);
        fs.writeFileSync(absoluteFilePath, file.buffer);

        const imageRecord: TaskImage = {
          id: imageId,
          filename: file.originalname,
          url: `/api/static/images/${storedName}`,
          absolutePath: absoluteFilePath,
          createdAt: new Date().toISOString(),
        };

        res.json(imageRecord);
      } catch (err: any) {
        console.error('Image upload error:', err);
        sendApiError(res, createApiError(500, 'UPLOAD_ERROR', err.message, { retryable: true }));
      }
    }
  );

  app.post(
    '/api/tasks/:taskId/attachments',
    (req, res, next) => {
      upload.single('file')(req, res, (err: any) => {
        if (err) {
          return sendApiError(
            res,
            createApiError(400, 'UPLOAD_FAILED', err.message || 'Upload failed', { retryable: false }),
          );
        }
        next();
      });
    },
    (req, res) => {
      try {
        const task = findTaskByIdentifier(deps.state, req.params.taskId);
        if (!task) {
          return sendApiError(res, createApiError(404, 'TASK_NOT_FOUND', `Task ${req.params.taskId} not found`, { retryable: false, affectedId: req.params.taskId }));
        }

        const file = (req as any).file as Express.Multer.File | undefined;
        if (!file) {
          return sendApiError(res, createApiError(400, 'NO_FILE', 'No file uploaded under field "file"', { retryable: false }));
        }

        if (!isAllowedMime(file.mimetype)) {
          return sendApiError(
            res,
            createApiError(415, 'UNSUPPORTED_MEDIA_TYPE', `Mime type not allowed: ${file.mimetype}`, { retryable: false }),
          );
        }

        const taskUploadDir = getTaskUploadsDir(task.id);
        fs.mkdirSync(taskUploadDir, { recursive: true });

        const attachmentId = `att-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
        const safeName = sanitizeFileName(file.originalname);
        const storedName = `${attachmentId}-${safeName}`;
        const absoluteFilePath = path.join(taskUploadDir, storedName);
        fs.writeFileSync(absoluteFilePath, file.buffer);

        const relativePath = toRelativeFromUploads(absoluteFilePath);
        const now = new Date().toISOString();

        const record = createAttachment({
          id: attachmentId,
          taskId: task.id,
          projectId: task.projectId || null,
          kind: detectKind(file.mimetype, file.originalname),
          originalName: file.originalname,
          storedName,
          mimeType: file.mimetype,
          sizeBytes: file.size,
          relativePath,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        });

        return res.status(201).json(record);
      } catch (error) {
        return sendApiError(res, error);
      }
    },
  );

  app.get('/api/tasks/:taskId/attachments', (req, res) => {
    try {
      const task = findTaskByIdentifier(deps.state, req.params.taskId);
      if (!task) {
        return sendApiError(res, createApiError(404, 'TASK_NOT_FOUND', `Task ${req.params.taskId} not found`, { retryable: false, affectedId: req.params.taskId }));
      }
      const list = listAttachmentsForTask(task.id);
      return res.json({ taskId: task.id, attachments: list });
    } catch (error) {
      return sendApiError(res, error);
    }
  });

  app.get('/api/attachments/:attachmentId', (req, res) => {
    try {
      const att = getAttachment(req.params.attachmentId);
      if (!att) {
        return sendApiError(res, createApiError(404, 'ATTACHMENT_NOT_FOUND', `Attachment ${req.params.attachmentId} not found`, { retryable: false, affectedId: req.params.attachmentId }));
      }
      const uploadsRoot = getDevFlowUploadsDir();
      const absolute = path.resolve(uploadsRoot, att.relativePath);
      if (!absolute.startsWith(path.resolve(uploadsRoot))) {
        return sendApiError(res, createApiError(403, 'PATH_TRAVERSAL', 'Invalid attachment path', { retryable: false }));
      }
      if (!fs.existsSync(absolute)) {
        return sendApiError(res, createApiError(410, 'FILE_MISSING', 'Attachment file missing on disk', { retryable: false, affectedId: att.id }));
      }
      if (att.mimeType) res.setHeader('Content-Type', att.mimeType);
      res.setHeader('Content-Disposition', `inline; filename="${att.originalName.replace(/"/g, '')}"`);
      return res.sendFile(absolute);
    } catch (error) {
      return sendApiError(res, error);
    }
  });

  app.delete('/api/attachments/:attachmentId', (req, res) => {
    try {
      const att = getAttachment(req.params.attachmentId);
      if (!att) {
        return sendApiError(res, createApiError(404, 'ATTACHMENT_NOT_FOUND', `Attachment ${req.params.attachmentId} not found`, { retryable: false, affectedId: req.params.attachmentId }));
      }
      const ok = softDeleteAttachment(att.id);
      if (!ok) {
        return sendApiError(res, createApiError(500, 'SOFT_DELETE_FAILED', 'Could not soft delete attachment', { retryable: true, affectedId: att.id }));
      }
      return res.json({ ok: true, id: att.id });
    } catch (error) {
      return sendApiError(res, error);
    }
  });
}
