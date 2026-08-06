/**
 * ProjectService
 *
 * Manages Projects as first-class workspace resources.
 * Each project has exactly one board (1:1).
 * Collection: projects
 */

import { generateProjectId } from '@teros/core';
import type { Db } from 'mongodb';
import type { Project } from '../types/database';

export class ProjectService {
  private col;

  constructor(private db: Db) {
    this.col = db.collection<Project>('projects');
    this.col.createIndex({ workspaceId: 1 }).catch(() => {}); // intentional: index may already exist — cleanup only
    this.col.createIndex({ boardId: 1 }, { unique: true }).catch(() => {}); // intentional: index may already exist — cleanup only
  }

  async create(
    workspaceId: string,
    userId: string,
    data: { name: string; description?: string; context?: string; boardId: string },
  ): Promise<Project> {
    const now = new Date().toISOString();
    const project: Project = {
      projectId: generateProjectId(),
      workspaceId,
      name: data.name,
      description: data.description,
      context: data.context,
      boardId: data.boardId,
      status: 'active',
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    };
    await this.col.insertOne(project as any);
    return project;
  }

  async list(workspaceId: string): Promise<Project[]> {
    return this.col
      .find({ workspaceId }, { projection: { _id: 0 } })
      .sort({ createdAt: 1 })
      .toArray();
  }

  async get(projectId: string): Promise<Project | null> {
    return this.col.findOne({ projectId }, { projection: { _id: 0 } });
  }

  async getByBoardId(boardId: string): Promise<Project | null> {
    return this.col.findOne({ boardId }, { projection: { _id: 0 } });
  }

  async update(
    projectId: string,
    data: { name?: string; description?: string; context?: string },
  ): Promise<Project | null> {
    const update: Partial<Project> = { updatedAt: new Date().toISOString() };
    if (data.name !== undefined) update.name = data.name;
    if (data.description !== undefined) update.description = data.description;
    if (data.context !== undefined) update.context = data.context;

    await this.col.updateOne({ projectId }, { $set: update });
    return this.get(projectId);
  }

  async delete(projectId: string): Promise<boolean> {
    const result = await this.col.deleteOne({ projectId });
    return result.deletedCount > 0;
  }

  async linkBoard(projectId: string, boardId: string): Promise<void> {
    await this.col.updateOne(
      { projectId },
      { $set: { boardId, updatedAt: new Date().toISOString() } },
    );
  }
}
