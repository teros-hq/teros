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
import { DeletionService } from './deletion-service';

export class ProjectService {
  private col;

  constructor(private db: Db) {
    this.col = db.collection<Project>('projects');
    // Indexes ({workspaceId}, unique {boardId}) live in src/db/indexes.ts (GOV-4).
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

  /**
   * Delete a project with its board, tasks, events and relationships (INF-3:
   * this path used to delete only the project document).
   */
  async delete(projectId: string, actor = 'system'): Promise<boolean> {
    const existed = (await this.col.countDocuments({ projectId })) > 0;
    await new DeletionService(this.db).deleteProject(projectId, actor);
    return existed;
  }

  async linkBoard(projectId: string, boardId: string): Promise<void> {
    await this.col.updateOne(
      { projectId },
      { $set: { boardId, updatedAt: new Date().toISOString() } },
    );
  }
}
