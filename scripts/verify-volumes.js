/**
 * Volume Verification Script
 * 
 * Verifies the integrity of volume assignments across the system:
 * 1. Users without volumeId
 * 2. Workspaces without volumeId
 * 3. User apps without volumes
 * 4. Workspace apps without volumes
 * 5. Apps with incorrect volume assignments (not matching owner's volume)
 */

const { MongoClient } = require('mongodb');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const DB_NAME = 'teros';

async function verifyVolumes() {
  const client = new MongoClient(MONGODB_URI);
  
  try {
    await client.connect();
    console.log('Connected to MongoDB\n');
    
    const db = client.db(DB_NAME);
    const users = db.collection('users');
    const workspaces = db.collection('workspaces');
    const apps = db.collection('apps');
    const volumes = db.collection('volumes');
    
    const issues = {
      usersWithoutVolume: [],
      workspacesWithoutVolume: [],
      userAppsWithoutVolume: [],
      workspaceAppsWithoutVolume: [],
      userAppsWithWrongVolume: [],
      workspaceAppsWithWrongVolume: []
    };
    
    // ========================================================================
    // 1. Check users without volumeId
    // ========================================================================
    console.log('Checking users...');
    
    const usersWithoutVolume = await users.find({
      $or: [
        { volumeId: { $exists: false } },
        { volumeId: null }
      ]
    }).toArray();
    
    for (const user of usersWithoutVolume) {
      issues.usersWithoutVolume.push({
        userId: user.userId,
        email: user.profile.email
      });
    }
    
    // ========================================================================
    // 2. Check workspaces without volumeId
    // ========================================================================
    console.log('Checking workspaces...');
    
    const workspacesWithoutVolume = await workspaces.find({
      $or: [
        { volumeId: { $exists: false } },
        { volumeId: null }
      ]
    }).toArray();
    
    for (const workspace of workspacesWithoutVolume) {
      issues.workspacesWithoutVolume.push({
        workspaceId: workspace.workspaceId,
        name: workspace.name
      });
    }
    
    // ========================================================================
    // 3. Check user apps without volumes
    // ========================================================================
    console.log('Checking user apps...');
    
    const userAppsWithoutVolume = await apps.find({
      ownerType: 'user',
      $or: [
        { volumes: { $exists: false } },
        { volumes: [] }
      ]
    }).toArray();
    
    for (const app of userAppsWithoutVolume) {
      issues.userAppsWithoutVolume.push({
        appId: app.appId,
        name: app.name,
        ownerId: app.ownerId
      });
    }
    
    // ========================================================================
    // 4. Check workspace apps without volumes
    // ========================================================================
    console.log('Checking workspace apps...');
    
    const workspaceAppsWithoutVolume = await apps.find({
      ownerType: 'workspace',
      $or: [
        { volumes: { $exists: false } },
        { volumes: [] }
      ]
    }).toArray();
    
    for (const app of workspaceAppsWithoutVolume) {
      issues.workspaceAppsWithoutVolume.push({
        appId: app.appId,
        name: app.name,
        ownerId: app.ownerId
      });
    }
    
    // ========================================================================
    // 5. Check apps with wrong volume assignments
    // ========================================================================
    console.log('Checking user app volumes...');
    
    // Check user apps
    const userAppsWithVolumes = await apps.aggregate([
      {
        $match: {
          ownerType: 'user',
          volumes: { $exists: true, $ne: [] }
        }
      },
      {
        $lookup: {
          from: 'users',
          localField: 'ownerId',
          foreignField: 'userId',
          as: 'owner'
        }
      },
      {
        $project: {
          appId: 1,
          name: 1,
          ownerId: 1,
          appVolumeId: { $arrayElemAt: ['$volumes.volumeId', 0] },
          ownerVolumeId: { $arrayElemAt: ['$owner.volumeId', 0] },
          ownerEmail: { $arrayElemAt: ['$owner.profile.email', 0] }
        }
      }
    ]).toArray();
    
    for (const app of userAppsWithVolumes) {
      if (app.appVolumeId !== app.ownerVolumeId) {
        issues.userAppsWithWrongVolume.push({
          appId: app.appId,
          name: app.name,
          ownerId: app.ownerId,
          currentVolume: app.appVolumeId,
          expectedVolume: app.ownerVolumeId
        });
      }
    }
    
    console.log('Checking workspace app volumes...');
    
    // Check workspace apps
    const workspaceAppsWithVolumes = await apps.aggregate([
      {
        $match: {
          ownerType: 'workspace',
          volumes: { $exists: true, $ne: [] }
        }
      },
      {
        $lookup: {
          from: 'workspaces',
          localField: 'ownerId',
          foreignField: 'workspaceId',
          as: 'owner'
        }
      },
      {
        $project: {
          appId: 1,
          name: 1,
          ownerId: 1,
          appVolumeId: { $arrayElemAt: ['$volumes.volumeId', 0] },
          ownerVolumeId: { $arrayElemAt: ['$owner.volumeId', 0] },
          ownerName: { $arrayElemAt: ['$owner.name', 0] }
        }
      }
    ]).toArray();
    
    for (const app of workspaceAppsWithVolumes) {
      if (app.appVolumeId !== app.ownerVolumeId) {
        issues.workspaceAppsWithWrongVolume.push({
          appId: app.appId,
          name: app.name,
          ownerId: app.ownerId,
          currentVolume: app.appVolumeId,
          expectedVolume: app.ownerVolumeId
        });
      }
    }
    
    // ========================================================================
    // SUMMARY - Get totals
    // ========================================================================
    
    const totalUsers = await users.countDocuments({});
    const totalWorkspaces = await workspaces.countDocuments({});
    const totalUserApps = await apps.countDocuments({ ownerType: 'user' });
    const totalWorkspaceApps = await apps.countDocuments({ ownerType: 'workspace' });
    
    const totalIssues = 
      issues.usersWithoutVolume.length +
      issues.workspacesWithoutVolume.length +
      issues.userAppsWithoutVolume.length +
      issues.workspaceAppsWithoutVolume.length +
      issues.userAppsWithWrongVolume.length +
      issues.workspaceAppsWithWrongVolume.length;
    
    // ========================================================================
    // MARKDOWN REPORT
    // ========================================================================
    console.log('\n\n');
    console.log('# 📊 Volume Verification Report');
    console.log('');
    console.log(`**Date:** ${new Date().toISOString()}`);
    console.log(`**Database:** ${DB_NAME}`);
    console.log('');
    console.log('---');
    console.log('');
    console.log('## Summary');
    console.log('');
    console.log('| Category | Total | ✅ OK | ❌ Issues | % OK |');
    console.log('|----------|------:|------:|---------:|-----:|');
    
    const userOk = totalUsers - issues.usersWithoutVolume.length;
    const userPct = totalUsers > 0 ? ((userOk / totalUsers) * 100).toFixed(1) : '0.0';
    console.log(`| **Users** | ${totalUsers} | ${userOk} | ${issues.usersWithoutVolume.length} | ${userPct}% |`);
    
    const workspaceOk = totalWorkspaces - issues.workspacesWithoutVolume.length;
    const workspacePct = totalWorkspaces > 0 ? ((workspaceOk / totalWorkspaces) * 100).toFixed(1) : '0.0';
    console.log(`| **Workspaces** | ${totalWorkspaces} | ${workspaceOk} | ${issues.workspacesWithoutVolume.length} | ${workspacePct}% |`);
    
    const userAppIssues = issues.userAppsWithoutVolume.length + issues.userAppsWithWrongVolume.length;
    const userAppOk = totalUserApps - userAppIssues;
    const userAppPct = totalUserApps > 0 ? ((userAppOk / totalUserApps) * 100).toFixed(1) : '0.0';
    console.log(`| **User Apps** | ${totalUserApps} | ${userAppOk} | ${userAppIssues} | ${userAppPct}% |`);
    
    const workspaceAppIssues = issues.workspaceAppsWithoutVolume.length + issues.workspaceAppsWithWrongVolume.length;
    const workspaceAppOk = totalWorkspaceApps - workspaceAppIssues;
    const workspaceAppPct = totalWorkspaceApps > 0 ? ((workspaceAppOk / totalWorkspaceApps) * 100).toFixed(1) : '0.0';
    console.log(`| **Workspace Apps** | ${totalWorkspaceApps} | ${workspaceAppOk} | ${workspaceAppIssues} | ${workspaceAppPct}% |`);
    
    console.log('');
    console.log('---');
    console.log('');
    console.log('## Detailed Issues');
    console.log('');
    
    // Users without volume
    console.log(`### 1️⃣ Users without volumeId (${issues.usersWithoutVolume.length})`);
    console.log('');
    if (issues.usersWithoutVolume.length > 0) {
      console.log('| User ID | Email |');
      console.log('|---------|-------|');
      issues.usersWithoutVolume.forEach(u => {
        console.log(`| \`${u.userId}\` | ${u.email} |`);
      });
    } else {
      console.log('✅ No issues found');
    }
    console.log('');
    
    // Workspaces without volume
    console.log(`### 2️⃣ Workspaces without volumeId (${issues.workspacesWithoutVolume.length})`);
    console.log('');
    if (issues.workspacesWithoutVolume.length > 0) {
      console.log('| Workspace ID | Name |');
      console.log('|--------------|------|');
      issues.workspacesWithoutVolume.forEach(w => {
        console.log(`| \`${w.workspaceId}\` | ${w.name} |`);
      });
    } else {
      console.log('✅ No issues found');
    }
    console.log('');
    
    // User apps without volume
    console.log(`### 3️⃣ User apps without volumes (${issues.userAppsWithoutVolume.length})`);
    console.log('');
    if (issues.userAppsWithoutVolume.length > 0) {
      console.log('| App ID | Name | Owner |');
      console.log('|--------|------|-------|');
      issues.userAppsWithoutVolume.forEach(a => {
        console.log(`| \`${a.appId}\` | ${a.name} | \`${a.ownerId}\` |`);
      });
    } else {
      console.log('✅ No issues found');
    }
    console.log('');
    
    // Workspace apps without volume
    console.log(`### 4️⃣ Workspace apps without volumes (${issues.workspaceAppsWithoutVolume.length})`);
    console.log('');
    if (issues.workspaceAppsWithoutVolume.length > 0) {
      console.log('| App ID | Name | Owner |');
      console.log('|--------|------|-------|');
      issues.workspaceAppsWithoutVolume.forEach(a => {
        console.log(`| \`${a.appId}\` | ${a.name} | \`${a.ownerId}\` |`);
      });
    } else {
      console.log('✅ No issues found');
    }
    console.log('');
    
    // User apps with wrong volume
    console.log(`### 5️⃣ User apps with wrong volume (${issues.userAppsWithWrongVolume.length})`);
    console.log('');
    if (issues.userAppsWithWrongVolume.length > 0) {
      console.log('| App ID | Name | Owner | Current | Expected |');
      console.log('|--------|------|-------|---------|----------|');
      issues.userAppsWithWrongVolume.forEach(a => {
        console.log(`| \`${a.appId}\` | ${a.name} | \`${a.ownerId}\` | \`${a.currentVolume}\` | \`${a.expectedVolume}\` |`);
      });
    } else {
      console.log('✅ No issues found');
    }
    console.log('');
    
    // Workspace apps with wrong volume
    console.log(`### 6️⃣ Workspace apps with wrong volume (${issues.workspaceAppsWithWrongVolume.length})`);
    console.log('');
    if (issues.workspaceAppsWithWrongVolume.length > 0) {
      console.log('| App ID | Name | Owner | Current | Expected |');
      console.log('|--------|------|-------|---------|----------|');
      issues.workspaceAppsWithWrongVolume.forEach(a => {
        console.log(`| \`${a.appId}\` | ${a.name} | \`${a.ownerId}\` | \`${a.currentVolume}\` | \`${a.expectedVolume}\` |`);
      });
    } else {
      console.log('✅ No issues found');
    }
    console.log('');
    
    console.log('---');
    console.log('');
    console.log('## Final Status');
    console.log('');
    if (totalIssues === 0) {
      console.log('✅ **All volume assignments are correct!**');
    } else {
      console.log(`❌ **Found ${totalIssues} issues that need to be fixed**`);
    }
    console.log('');
    
    return issues;
    
  } catch (error) {
    console.error('Verification failed:', error);
    throw error;
  } finally {
    await client.close();
    console.log('\nDisconnected from MongoDB');
  }
}

// Run verification
verifyVolumes()
  .then((issues) => {
    const totalIssues = Object.values(issues).reduce((sum, arr) => sum + arr.length, 0);
    process.exit(totalIssues > 0 ? 1 : 0);
  })
  .catch((error) => {
    console.error('\n❌ Script failed:', error);
    process.exit(1);
  });
