/**
 * Complete Volume Migration Script
 * 
 * Fixes all volume-related issues:
 * 1. Creates volumes for users without volumeId
 * 2. Creates volumes for workspaces without volumeId
 * 3. Assigns volumes to user apps without volumes
 * 4. Assigns volumes to workspace apps without volumes
 * 5. Fixes apps with wrong volume assignments
 */

const { MongoClient } = require('mongodb');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const DB_NAME = 'teros';

// Dry run mode - set to false to actually make changes
const DRY_RUN = process.env.DRY_RUN !== 'false';

async function fixAllVolumes() {
  const client = new MongoClient(MONGODB_URI);
  
  try {
    await client.connect();
    console.log('Connected to MongoDB');
    console.log(`Mode: ${DRY_RUN ? '🔍 DRY RUN (no changes will be made)' : '✍️  WRITE MODE (changes will be applied)'}\n`);
    
    const db = client.db(DB_NAME);
    const users = db.collection('users');
    const workspaces = db.collection('workspaces');
    const apps = db.collection('apps');
    const volumes = db.collection('volumes');
    
    const stats = {
      usersFixed: 0,
      workspacesFixed: 0,
      userAppsFixed: 0,
      workspaceAppsFixed: 0,
      errors: []
    };
    
    // ========================================================================
    // 1. Fix users without volumeId
    // ========================================================================
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('1️⃣  FIXING USERS WITHOUT VOLUME');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    
    const usersWithoutVolume = await users.find({
      $or: [
        { volumeId: { $exists: false } },
        { volumeId: null }
      ]
    }).toArray();
    
    console.log(`Found ${usersWithoutVolume.length} users without volumeId\n`);
    
    for (const user of usersWithoutVolume) {
      try {
        // Generate volume ID
        const volumeId = `vol_user_${Math.random().toString(36).substring(2, 18)}`;
        
        console.log(`${DRY_RUN ? '🔍' : '✅'} ${user.userId} (${user.profile.email})`);
        console.log(`   Creating volume: ${volumeId}`);
        
        if (!DRY_RUN) {
          // Create volume
          await volumes.insertOne({
            volumeId,
            type: 'user',
            ownerId: user.userId,
            name: `${user.profile.displayName}'s Volume`,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          });
          
          // Update user
          await users.updateOne(
            { userId: user.userId },
            { 
              $set: { 
                volumeId,
                updatedAt: new Date()
              } 
            }
          );
        }
        
        stats.usersFixed++;
      } catch (error) {
        console.error(`   ❌ Error: ${error.message}`);
        stats.errors.push({ type: 'user', id: user.userId, error: error.message });
      }
    }
    
    console.log(`\n${DRY_RUN ? 'Would fix' : 'Fixed'}: ${stats.usersFixed} users\n`);
    
    // ========================================================================
    // 2. Fix workspaces without volumeId
    // ========================================================================
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('2️⃣  FIXING WORKSPACES WITHOUT VOLUME');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    
    const workspacesWithoutVolume = await workspaces.find({
      $or: [
        { volumeId: { $exists: false } },
        { volumeId: null }
      ]
    }).toArray();
    
    console.log(`Found ${workspacesWithoutVolume.length} workspaces without volumeId\n`);
    
    for (const workspace of workspacesWithoutVolume) {
      try {
        // Generate volume ID
        const volumeId = `vol_work_${Math.random().toString(36).substring(2, 18)}`;
        
        console.log(`${DRY_RUN ? '🔍' : '✅'} ${workspace.workspaceId} (${workspace.name})`);
        console.log(`   Creating volume: ${volumeId}`);
        
        if (!DRY_RUN) {
          // Create volume
          await volumes.insertOne({
            volumeId,
            type: 'workspace',
            ownerId: workspace.workspaceId,
            name: `${workspace.name} Volume`,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          });
          
          // Update workspace
          await workspaces.updateOne(
            { workspaceId: workspace.workspaceId },
            { 
              $set: { 
                volumeId,
                updatedAt: new Date().toISOString()
              } 
            }
          );
        }
        
        stats.workspacesFixed++;
      } catch (error) {
        console.error(`   ❌ Error: ${error.message}`);
        stats.errors.push({ type: 'workspace', id: workspace.workspaceId, error: error.message });
      }
    }
    
    console.log(`\n${DRY_RUN ? 'Would fix' : 'Fixed'}: ${stats.workspacesFixed} workspaces\n`);
    
    // ========================================================================
    // 3. Fix user apps without volumes or with wrong volumes
    // ========================================================================
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('3️⃣  FIXING USER APPS');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    
    // Get all user apps that need fixing
    const userAppsToFix = await apps.aggregate([
      {
        $match: {
          ownerType: 'user'
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
          volumes: 1,
          appVolumeId: { $arrayElemAt: ['$volumes.volumeId', 0] },
          ownerVolumeId: { $arrayElemAt: ['$owner.volumeId', 0] },
          ownerEmail: { $arrayElemAt: ['$owner.profile.email', 0] }
        }
      },
      {
        $match: {
          $or: [
            { volumes: { $exists: false } },
            { volumes: [] },
            { $expr: { $ne: ['$appVolumeId', '$ownerVolumeId'] } }
          ]
        }
      }
    ]).toArray();
    
    console.log(`Found ${userAppsToFix.length} user apps to fix\n`);
    
    for (const app of userAppsToFix) {
      try {
        if (!app.ownerVolumeId) {
          console.log(`⚠️  SKIP: ${app.appId} (${app.name}) - owner ${app.ownerId} has no volumeId`);
          continue;
        }
        
        console.log(`${DRY_RUN ? '🔍' : '✅'} ${app.appId} (${app.name})`);
        console.log(`   Owner: ${app.ownerId} (${app.ownerEmail})`);
        console.log(`   Setting volume: ${app.ownerVolumeId}`);
        
        if (!DRY_RUN) {
          await apps.updateOne(
            { appId: app.appId },
            {
              $set: {
                volumes: [{
                  volumeId: app.ownerVolumeId,
                  mountPath: '/workspace',
                  readOnly: false
                }],
                updatedAt: new Date().toISOString()
              }
            }
          );
        }
        
        stats.userAppsFixed++;
      } catch (error) {
        console.error(`   ❌ Error: ${error.message}`);
        stats.errors.push({ type: 'user-app', id: app.appId, error: error.message });
      }
    }
    
    console.log(`\n${DRY_RUN ? 'Would fix' : 'Fixed'}: ${stats.userAppsFixed} user apps\n`);
    
    // ========================================================================
    // 4. Fix workspace apps without volumes or with wrong volumes
    // ========================================================================
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('4️⃣  FIXING WORKSPACE APPS');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    
    // Get all workspace apps that need fixing
    const workspaceAppsToFix = await apps.aggregate([
      {
        $match: {
          ownerType: 'workspace'
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
          volumes: 1,
          appVolumeId: { $arrayElemAt: ['$volumes.volumeId', 0] },
          ownerVolumeId: { $arrayElemAt: ['$owner.volumeId', 0] },
          ownerName: { $arrayElemAt: ['$owner.name', 0] }
        }
      },
      {
        $match: {
          $or: [
            { volumes: { $exists: false } },
            { volumes: [] },
            { $expr: { $ne: ['$appVolumeId', '$ownerVolumeId'] } }
          ]
        }
      }
    ]).toArray();
    
    console.log(`Found ${workspaceAppsToFix.length} workspace apps to fix\n`);
    
    for (const app of workspaceAppsToFix) {
      try {
        if (!app.ownerVolumeId) {
          console.log(`⚠️  SKIP: ${app.appId} (${app.name}) - workspace ${app.ownerId} has no volumeId`);
          continue;
        }
        
        console.log(`${DRY_RUN ? '🔍' : '✅'} ${app.appId} (${app.name})`);
        console.log(`   Owner: ${app.ownerId} (${app.ownerName})`);
        console.log(`   Setting volume: ${app.ownerVolumeId}`);
        
        if (!DRY_RUN) {
          await apps.updateOne(
            { appId: app.appId },
            {
              $set: {
                volumes: [{
                  volumeId: app.ownerVolumeId,
                  mountPath: '/workspace',
                  readOnly: false
                }],
                updatedAt: new Date().toISOString()
              }
            }
          );
        }
        
        stats.workspaceAppsFixed++;
      } catch (error) {
        console.error(`   ❌ Error: ${error.message}`);
        stats.errors.push({ type: 'workspace-app', id: app.appId, error: error.message });
      }
    }
    
    console.log(`\n${DRY_RUN ? 'Would fix' : 'Fixed'}: ${stats.workspaceAppsFixed} workspace apps\n`);
    
    // ========================================================================
    // SUMMARY
    // ========================================================================
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📊 MIGRATION SUMMARY');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    
    console.log(`${DRY_RUN ? 'Would fix' : 'Fixed'}:`);
    console.log(`  Users:          ${stats.usersFixed}`);
    console.log(`  Workspaces:     ${stats.workspacesFixed}`);
    console.log(`  User Apps:      ${stats.userAppsFixed}`);
    console.log(`  Workspace Apps: ${stats.workspaceAppsFixed}`);
    console.log(`  ${'─'.repeat(40)}`);
    console.log(`  TOTAL:          ${stats.usersFixed + stats.workspacesFixed + stats.userAppsFixed + stats.workspaceAppsFixed}`);
    
    if (stats.errors.length > 0) {
      console.log(`\n❌ Errors: ${stats.errors.length}`);
      stats.errors.forEach(err => {
        console.log(`   ${err.type}: ${err.id} - ${err.error}`);
      });
    } else {
      console.log('\n✅ No errors');
    }
    
    if (DRY_RUN) {
      console.log('\n💡 To apply changes, run: DRY_RUN=false node scripts/fix-all-volumes.js');
    }
    
    return stats;
    
  } catch (error) {
    console.error('Migration failed:', error);
    throw error;
  } finally {
    await client.close();
    console.log('\nDisconnected from MongoDB');
  }
}

// Run migration
fixAllVolumes()
  .then((stats) => {
    console.log('\n✅ Script completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Script failed:', error);
    process.exit(1);
  });
