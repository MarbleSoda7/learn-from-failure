/**
 * Learn From Failure Plugin (v3.0 - Experience Learning System)
 * 
 * Features:
 * 1. Auto-record tool execution failures
 * 2. User-submitted error reports and solutions
 * 3. Search historical errors and solutions
 * 4. Auto-cleanup temporary/debug files
 * 5. Experience recording (success & failure)
 * 6. Global & project-specific knowledge base
 * 7. Root cause analysis enforcement
 * 8. Temporary solution tracking
 */

import { z } from 'zod';
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import { resolve, join, dirname } from 'path';
import { promises as fs } from 'fs';
import { createHash } from 'crypto';
import { homedir } from 'os';

export const inject = ['storageDomain', 'systemPrompt', 'tools', 'commands', 'sessions', 'workingDirectory'];

// Error type classification
const ERROR_TYPES = {
  PERMISSION: /permission denied|access denied|eperm|eacces/i,
  NOT_FOUND: /not found|no such file|enoent|cannot find/i,
  SYNTAX: /syntax error|unexpected token|parse error/i,
  TIMEOUT: /timeout|timed out|etimedout/i,
  NETWORK: /network error|connection refused|econnrefused|fetch failed/i,
  FILESYSTEM: /file system|fs_stale_version|already exists|eexist/i,
  COMMAND: /command not found|exit code|command failed/i,
  VALIDATION: /invalid|validation failed|schema|type error/i,
};

// Temporary file patterns to cleanup
const TEMP_FILE_PATTERNS = [
  /\.tmp$/i,
  /\.temp$/i,
  /^tmp_/i,
  /^debug_/i,
  /^test_\d+/i,
  /_debug\.log$/i,
  /_error\.log$/i,
  /\.bak$/i,
  /~$/,
];

// "Workaround" detection patterns
const WORKAROUND_PATTERNS = [
  /try.*catch.*ignore/i,
  /disable.*check/i,
  /skip.*validation/i,
  /comment.*out/i,
  /create.*empty/i,
  /fake.*data/i,
  /bypass.*permission/i,
  /suppress.*error/i,
  /rewrite.*from.*scratch/i,
  /start.*over/i,
  /new.*project/i,
];

// Zod Schemas
const FailureSchema = z.object({
  id: z.string(),
  timestamp: z.number(),
  sessionId: z.string(),
  toolName: z.string(),
  toolArgs: z.record(z.unknown()).optional(),
  errorType: z.string(),
  errorMessage: z.string(),
  errorCode: z.union([z.string(), z.number()]).optional(),
  context: z.object({
    workingDirectory: z.string().optional(),
    toolCallId: z.string().optional(),
    userContext: z.string().optional(),
  }),
  recurrenceCount: z.number(),
  solution: z.string().optional(),
  resolved: z.boolean().default(false),
  tags: z.array(z.string()).optional(),
});

const PatternSchema = z.object({
  id: z.string(),
  signature: z.string(),
  occurrenceCount: z.number(),
  lastSeen: z.number(),
  commonSolutions: z.array(z.string()).optional(),
});

const UserReportSchema = z.object({
  id: z.string(),
  timestamp: z.number(),
  sessionId: z.string(),
  errorDescription: z.string(),
  errorContext: z.string().optional(),
  solution: z.string().optional(),
  tags: z.array(z.string()).optional(),
  relatedFailureId: z.string().optional(),
});

const CleanupRecordSchema = z.object({
  id: z.string(),
  timestamp: z.number(),
  sessionId: z.string(),
  filePath: z.string(),
  fileSize: z.number(),
  reason: z.string(),
});

// NEW: Experience Schema
const ExperienceSchema = z.object({
  id: z.string(),
  timestamp: z.number(),
  sessionId: z.string(),
  type: z.enum(['success', 'failure']),
  scope: z.enum(['global', 'project']),
  projectPath: z.string().optional(),
  description: z.string(),
  context: z.string().optional(),
  tags: z.union([z.array(z.string()), z.string()]).transform(val => 
    typeof val === 'string' ? val.split(',').map(t => t.trim()).filter(Boolean) : val
  ).default([]),
  solutionType: z.enum(['root_cause', 'workaround', 'temporary']).optional(),
  rootCause: z.string().optional(),
  whyItHappened: z.string().optional(),
  alternative: z.string().optional(),
  isTemporary: z.boolean().default(false),
  relatedFailureId: z.string().optional(),
  baseline: z.string().optional(), // For tracking successful baselines
});

// Global domain definition
let globalDomainSpec;
try {
  globalDomainSpec = defineDomain({
    name: 'learn_from_failure',
    version: 3,
    invalidRecords: 'backup-and-skip',  // Skip invalid records instead of failing
    tables: {
      failures: domainTable(FailureSchema),
      patterns: domainTable(PatternSchema),
      user_reports: domainTable(UserReportSchema),
      cleanup_records: domainTable(CleanupRecordSchema),
      experiences: domainTable(ExperienceSchema),
    },
  });
  console.log('[learn-from-failure] Global domain spec created successfully');
  console.log('[learn-from-failure] Spec keys:', Object.keys(globalDomainSpec));
  console.log('[learn-from-failure] Spec.name:', globalDomainSpec.name);
  console.log('[learn-from-failure] Spec.version:', globalDomainSpec.version);
  console.log('[learn-from-failure] Spec.tables keys:', Object.keys(globalDomainSpec.tables || {}));
} catch (error) {
  console.error('[learn-from-failure] FATAL: Failed to create domain spec:', error);
  throw error;
}

// Project domain definition (stored in .experiences/)
function defineProjectDomain(projectPath) {
  // Use hash to avoid long domain names and special characters
  const hash = createHash('sha256').update(projectPath).digest('hex').substring(0, 16);
  return defineDomain({
    name: `project_${hash}`,
    version: 1,
    invalidRecords: 'backup-and-skip',  // Skip invalid records instead of failing
    tables: {
      experiences: domainTable(ExperienceSchema),
    },
  });
}

export function apply(ctx, config) {
  console.log('[learn-from-failure] ========================================');
  console.log('[learn-from-failure] Plugin apply() called');
  console.log('[learn-from-failure] Config:', JSON.stringify(config));
  console.log('[learn-from-failure] ========================================');
  
  const { storageDomain, systemPrompt, tools, commands } = ctx;
  
  console.log('[learn-from-failure] Services available:');
  console.log('[learn-from-failure]   - storageDomain:', !!storageDomain);
  console.log('[learn-from-failure]   - systemPrompt:', !!systemPrompt);
  console.log('[learn-from-failure]   - tools:', !!tools);
  console.log('[learn-from-failure]   - commands:', !!commands);
  console.log('[learn-from-failure]');

  // ===== PERSISTENCE LAYER =====
  
  // Get persistent storage paths
  const getGlobalStoragePath = () => {
    const profileDir = join(homedir(), '.dsh', 'profiles', 'desktop', 'learn-from-failure');
    return {
      dir: profileDir,
      experiences: join(profileDir, 'experiences.json'),
      failures: join(profileDir, 'failures.json'),
      patterns: join(profileDir, 'patterns.json'),
    };
  };
  
  const getProjectStoragePath = (projectPath) => {
    const expDir = join(projectPath, '.experiences');
    return {
      dir: expDir,
      experiences: join(expDir, 'experiences.json'),
    };
  };
  
  // Load data from JSON file
  async function loadFromFile(filePath) {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(content);
    } catch (err) {
      if (err.code === 'ENOENT') {
        return {}; // File doesn't exist yet
      }
      console.error(`[learn-from-failure] Failed to load ${filePath}:`, err);
      return {};
    }
  }
  
  // Save data to JSON file
  async function saveToFile(filePath, data) {
    const debugLog = [];
    debugLog.push(`[${new Date().toISOString()}] saveToFile called`);
    debugLog.push(`  filePath: ${filePath}`);
    debugLog.push(`  data keys: ${Object.keys(data).length}`);
    
    try {
      const dir = dirname(filePath);
      debugLog.push(`  dirname: ${dir}`);
      
      await fs.mkdir(dir, { recursive: true });
      debugLog.push(`  mkdir success`);
      
      const jsonContent = JSON.stringify(data, null, 2);
      debugLog.push(`  json length: ${jsonContent.length}`);
      
      await fs.writeFile(filePath, jsonContent, 'utf-8');
      debugLog.push(`  writeFile success`);
      
      // Write debug log
      try {
        await fs.writeFile(join(dir, 'debug.log'), debugLog.join('\n') + '\n\n', { flag: 'a' });
      } catch {}
      
      console.log(`[learn-from-failure] [OK] Saved to ${filePath}`);
    } catch (err) {
      debugLog.push(`  ERROR: ${err.message}`);
      debugLog.push(`  Stack: ${err.stack}`);
      
      // Write error log
      try {
        await fs.writeFile(join(dirname(filePath), 'error.log'), debugLog.join('\n') + '\n\n', { flag: 'a' });
      } catch {}
      
      console.error(`[learn-from-failure] [ERROR] Failed to save ${filePath}:`, err);
    }
  }
  
  // Wrap KvTable to add persistence
  function wrapTableWithPersistence(table, filePath, tableName) {
    console.log(`[learn-from-failure] Wrapping table '${tableName}' with persistence: ${filePath}`);
    
    return {
      get: (key) => table.get(key),
      entries: () => table.entries(),
      keys: () => table.keys(),
      get size() { return table.size; },
      
      put: async (key, value) => {
        console.log(`[learn-from-failure] PUT ${tableName}[${key}]`);
        await table.put(key, value);
        
        // Persist to file
        const allData = {};
        for (const [k, v] of table.entries()) {
          allData[k] = v;
        }
        console.log(`[learn-from-failure] Saving ${Object.keys(allData).length} records to ${filePath}`);
        await saveToFile(filePath, allData);
      },
      
      delete: async (key) => {
        console.log(`[learn-from-failure] DELETE ${tableName}[${key}]`);
        const result = await table.delete(key);
        
        // Persist to file
        const allData = {};
        for (const [k, v] of table.entries()) {
          allData[k] = v;
        }
        await saveToFile(filePath, allData);
        return result;
      },
      
      update: async (key, fn) => {
        console.log(`[learn-from-failure] UPDATE ${tableName}[${key}]`);
        const result = await table.update(key, fn);
        
        // Persist to file
        const allData = {};
        for (const [k, v] of table.entries()) {
          allData[k] = v;
        }
        await saveToFile(filePath, allData);
        return result;
      },
    };
  }

  // Global domain
  let globalDomain;
  
  // Use getter object to avoid closure capture
  const tables = {
    get failures() { return globalDomain?.table('failures'); },
    get patterns() { return globalDomain?.table('patterns'); },
    get userReports() { return globalDomain?.table('user_reports'); },
    get cleanupRecords() { return globalDomain?.table('cleanup_records'); },
    get globalExperiences() { return globalDomain?.table('experiences'); },
  };
  
  let failuresTable;
  let patternsTable;
  let userReportsTable;
  let cleanupRecordsTable;
  let globalExperiencesTable;

  // Project domains cache
  const projectDomains = new Map();

  // Open global domain
  console.log('[learn-from-failure] Opening global domain...');
  const globalDomainReady = (async () => {
    try {
      const d = await storageDomain.open(globalDomainSpec);
      console.log('[learn-from-failure] Global domain opened successfully');
      globalDomain = d;
      if (!globalDomain) {
        console.log('[learn-from-failure] Storage domain disabled, tables not initialized');
        return null;
      }

    // Get storage paths
    const storagePaths = getGlobalStoragePath();
    
    // Load persisted data
    console.log('[learn-from-failure] Loading persisted data...');
    const [experiencesData, failuresData, patternsData] = await Promise.all([
      loadFromFile(storagePaths.experiences),
      loadFromFile(storagePaths.failures),
      loadFromFile(storagePaths.patterns),
    ]);
    
    // Initialize tables
    failuresTable = globalDomain.table('failures');
    patternsTable = globalDomain.table('patterns');
    userReportsTable = globalDomain.table('user_reports');
    cleanupRecordsTable = globalDomain.table('cleanup_records');
    globalExperiencesTable = globalDomain.table('experiences');
    
    // Load data into tables
    for (const [key, value] of Object.entries(experiencesData)) {
      await globalExperiencesTable.put(key, value);
    }
    for (const [key, value] of Object.entries(failuresData)) {
      await failuresTable.put(key, value);
    }
    for (const [key, value] of Object.entries(patternsData)) {
      await patternsTable.put(key, value);
    }
    
    console.log('[learn-from-failure] Loaded persisted data:');
    console.log('[learn-from-failure]   - experiences:', Object.keys(experiencesData).length);
    console.log('[learn-from-failure]   - failures:', Object.keys(failuresData).length);
    console.log('[learn-from-failure]   - patterns:', Object.keys(patternsData).length);
    
    // Wrap tables with persistence
    failuresTable = wrapTableWithPersistence(failuresTable, storagePaths.failures, 'failures');
    patternsTable = wrapTableWithPersistence(patternsTable, storagePaths.patterns, 'patterns');
    globalExperiencesTable = wrapTableWithPersistence(globalExperiencesTable, storagePaths.experiences, 'experiences');
    
    console.log('[learn-from-failure]   - failuresTable:', !!failuresTable, 'size:', failuresTable?.size);
    console.log('[learn-from-failure]   - patternsTable:', !!patternsTable, 'size:', patternsTable?.size);
    console.log('[learn-from-failure]   - userReportsTable:', !!userReportsTable, 'size:', userReportsTable?.size);
    console.log('[learn-from-failure]   - cleanupRecordsTable:', !!cleanupRecordsTable, 'size:', cleanupRecordsTable?.size);
    console.log('[learn-from-failure]   - globalExperiencesTable:', !!globalExperiencesTable, 'size:', globalExperiencesTable?.size);
    
    console.log('[learn-from-failure] All tables initialized successfully!');
    return d;
  } catch (err) {
    console.error('[learn-from-failure] Failed to open global domain');
    console.error('[learn-from-failure]   Error name:', err?.name);
    console.error('[learn-from-failure]   Error message:', err?.message);
    console.error('[learn-from-failure]   Error stack:', err?.stack);
    // Write error to file for debugging
    try {
      const errorLogDir = join(homedir(), '.dsh');
      await fs.mkdir(errorLogDir, { recursive: true });
      const errorLogPath = join(errorLogDir, 'learn-from-failure-error.log');
      const errorLog = `[${new Date().toISOString()}] Failed to open global domain\n` +
        `Error name: ${err?.name}\n` +
        `Error message: ${err?.message}\n` +
        `Error stack: ${err?.stack}\n\n`;
      await fs.appendFile(errorLogPath, errorLog, 'utf-8');
    } catch (e) {
      console.error('Failed to write error log:', e);
    }
    return null;
  }
})();

  // Get or open project domain
  async function getProjectDomain(projectPath) {
    if (!projectPath) return null;
    
    const normalized = resolve(projectPath);
    if (projectDomains.has(normalized)) {
      return projectDomains.get(normalized);
    }

    try {
      const storagePaths = getProjectStoragePath(normalized);
      await fs.mkdir(storagePaths.dir, { recursive: true });
      
      // Project domains are stored in .experiences/ folder
      const projectSpec = defineProjectDomain(normalized);
      const domain = await storageDomain.open(projectSpec);
      
      // Load persisted project experiences
      const experiencesData = await loadFromFile(storagePaths.experiences);
      const projExpTable = domain.table('experiences');
      
      // Load data into table
      for (const [key, value] of Object.entries(experiencesData)) {
        await projExpTable.put(key, value);
      }
      
      console.log(`[learn-from-failure] Loaded project experiences: ${Object.keys(experiencesData).length}`);
      
      // Wrap table with persistence
      const wrappedTable = wrapTableWithPersistence(projExpTable, storagePaths.experiences, 'project-experiences');
      
      // Store domain with wrapped table reference
      const wrappedDomain = {
        ...domain,
        table: (name) => {
          if (name === 'experiences') return wrappedTable;
          return domain.table(name);
        }
      };
      
      projectDomains.set(normalized, wrappedDomain);
      console.log(`[learn-from-failure] Project domain opened: ${normalized}`);
      return wrappedDomain;
    } catch (err) {
      console.error(`[learn-from-failure] Failed to open project domain for ${normalized}:`, err);
      return null;
    }
  }

  // Helper: classify error
  function classifyError(errorMessage) {
    for (const [type, pattern] of Object.entries(ERROR_TYPES)) {
      if (pattern.test(errorMessage)) {
        return type.toLowerCase();
      }
    }
    return 'unknown';
  }

  // Helper: generate ID
  function generateId(prefix) {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
  }

  // Helper: detect workaround patterns
  function detectWorkaround(text) {
    return WORKAROUND_PATTERNS.some(pattern => pattern.test(text));
  }

  // Helper: search errors (global + project)
  function searchErrors(query, projectPath = null) {
    const results = [];
    const lowerQuery = query.toLowerCase();

    // Search in global failures
    if (failuresTable) {
      for (const [id, failure] of failuresTable.entries()) {
        const score = 
          (failure.errorMessage.toLowerCase().includes(lowerQuery) ? 2 : 0) +
          (failure.solution?.toLowerCase().includes(lowerQuery) ? 1 : 0) +
          (failure.tags?.some(tag => tag.toLowerCase().includes(lowerQuery)) ? 1 : 0);
        
        if (score > 0) {
          results.push({ type: 'failure', scope: 'global', data: failure, score });
        }
      }
    }

    // Search in global user reports
    if (userReportsTable) {
      for (const [id, report] of userReportsTable.entries()) {
        const score =
          (report.errorDescription.toLowerCase().includes(lowerQuery) ? 2 : 0) +
          (report.solution?.toLowerCase().includes(lowerQuery) ? 1 : 0) +
          (report.tags?.some(tag => tag.toLowerCase().includes(lowerQuery)) ? 1 : 0);
        
        if (score > 0) {
          results.push({ type: 'userReport', scope: 'global', data: report, score });
        }
      }
    }

    // Search in global experiences
    if (globalExperiencesTable) {
      for (const [id, exp] of globalExperiencesTable.entries()) {
        const score =
          (exp.description.toLowerCase().includes(lowerQuery) ? 2 : 0) +
          (exp.context?.toLowerCase().includes(lowerQuery) ? 1 : 0) +
          (exp.tags.some(tag => tag.toLowerCase().includes(lowerQuery)) ? 1 : 0);
        
        if (score > 0) {
          results.push({ type: 'experience', scope: 'global', data: exp, score });
        }
      }
    }

    // Search in project experiences if project path provided
    if (projectPath && projectDomains.has(resolve(projectPath))) {
      const projectDomain = projectDomains.get(resolve(projectPath));
      const projectExpTable = projectDomain.table('experiences');
      
      for (const [id, exp] of projectExpTable.entries()) {
        const score =
          (exp.description.toLowerCase().includes(lowerQuery) ? 3 : 0) + // Higher priority for project
          (exp.context?.toLowerCase().includes(lowerQuery) ? 2 : 0) +
          (exp.tags.some(tag => tag.toLowerCase().includes(lowerQuery)) ? 1 : 0);
        
        if (score > 0) {
          results.push({ type: 'experience', scope: 'project', data: exp, score });
        }
      }
    }

    return results.sort((a, b) => b.score - a.score);
  }

  // Helper: cleanup temporary files
  async function cleanupTempFiles(workingDir, sessionId) {
    const cleaned = [];
    
    try {
      const files = await fs.readdir(workingDir);
      
      for (const file of files) {
        const shouldClean = TEMP_FILE_PATTERNS.some(pattern => pattern.test(file));
        
        if (shouldClean) {
          const filePath = join(workingDir, file);
          try {
            const stats = await fs.stat(filePath);
            if (stats.isFile()) {
              await fs.unlink(filePath);
              
              const record = {
                id: generateId('cleanup'),
                timestamp: Date.now(),
                sessionId,
                filePath,
                fileSize: stats.size,
                reason: 'Matched temporary file pattern',
              };
              
              if (cleanupRecordsTable) {
                await cleanupRecordsTable.put(record.id, record);
              }
              cleaned.push({ file, size: stats.size });
            }
          } catch (err) {
            console.warn(`[learn-from-failure] Failed to cleanup ${file}:`, err.message);
          }
        }
      }
    } catch (err) {
      console.warn('[learn-from-failure] Cleanup scan failed:', err.message);
    }
    
    return cleaned;
  }

  // Event: Record tool failures
  ctx.on('tools/result', async (exec, result) => {
    console.log('[learn-from-failure] tools/result event triggered');
    console.log('[learn-from-failure]   - tool:', exec?.name);
    console.log('[learn-from-failure]   - isError:', result?.isError);
    
    if (!result.isError) {
      console.log('[learn-from-failure]   - Skipping: not an error');
      return;
    }
    
    console.log('[learn-from-failure]   - Waiting for global domain...');
    await globalDomainReady;
    console.log('[learn-from-failure]   - Global domain ready');
    
    if (!failuresTable || !patternsTable) {
      console.error('[learn-from-failure]   - CRITICAL: Tables not initialized!');
      console.error('[learn-from-failure]     - failuresTable:', !!failuresTable);
      console.error('[learn-from-failure]     - patternsTable:', !!patternsTable);
      return;
    }
    
    console.log('[learn-from-failure]   - Tables available, recording failure...');

    try {
      const failureId = generateId('failure');
      const timestamp = Date.now();
      const errorMessage = result.error?.message || 'Unknown error';
      const errorType = classifyError(errorMessage);
      const agent = exec.agent;
      const sessionId = agent?.id || 'unknown';

      // Update pattern
      const signature = `${exec.name}:${errorType}`;
      let pattern = patternsTable.get(signature);
      let recurrenceCount = 1;
      
      if (pattern) {
        recurrenceCount = pattern.occurrenceCount + 1;
        await patternsTable.put(signature, {
          ...pattern,
          occurrenceCount: recurrenceCount,
          lastSeen: timestamp,
        });
      } else {
        await patternsTable.put(signature, {
          id: generateId('pattern'),
          signature,
          occurrenceCount: 1,
          lastSeen: timestamp,
        });
      }

      // Record failure
      const failure = {
        id: failureId,
        timestamp,
        sessionId,
        toolName: exec.name,
        toolArgs: exec.arguments,
        errorType,
        errorMessage,
        errorCode: result.error?.info?.code,
        context: {
          workingDirectory: agent?.cwd,
          toolCallId: exec.callId,
        },
        recurrenceCount,
        resolved: false,
      };

      await failuresTable.put(failureId, failure);
      console.log(`[learn-from-failure] [OK] Recorded: ${exec.name} - ${errorType} (#${recurrenceCount})`);
      console.log(`[learn-from-failure]    Total failures now: ${failuresTable.size}`);
    } catch (error) {
      console.error('[learn-from-failure] [ERROR] Error recording failure:', error);
      console.error('[learn-from-failure]    Stack:', error.stack);
    }
  });

  // Event: Cleanup on session end
  ctx.on('session/end', async (session) => {
    await globalDomainReady;
    if (!cleanupRecordsTable) return;

    const workingDir = session?.cwd;
    if (!workingDir) return;

    try {
      const cleaned = await cleanupTempFiles(workingDir, session.id);
      if (cleaned.length > 0) {
        const totalSize = cleaned.reduce((sum, item) => sum + item.size, 0);
        console.log(`[learn-from-failure] Cleaned ${cleaned.length} temp files (${(totalSize / 1024).toFixed(2)} KB)`);
      }
    } catch (err) {
      console.warn('[learn-from-failure] Session cleanup failed:', err.message);
    }
  });

  // Tool: search_learned_errors (unchanged)
  ctx.effect(() => {
    return tools.register({
      name: 'search_learned_errors',
      description: 'Search historical error records and solutions from past failures. Use this when encountering an error to find if it has been solved before.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
        },
        required: ['query'],
        additionalProperties: true,
      },
      output: {
        schema: { type: 'object' },
        render: (args, value) => [{ type: 'text', text: `Found ${value?.totalFound ?? 0} error(s) for "${args.query}"` }],
      },
      execute: async ({ query, limit = 5 }, exec) => {
        await globalDomainReady;
        if (!failuresTable || !userReportsTable) {
          return { error: 'Database not ready' };
        }

        const agent = exec.agent;
        let projectPath;
        if (agent) {
          const session = ctx.sessions.get(agent.id);
          if (session) {
            projectPath = ctx.workingDirectory.get(session);
          }
        }
        
        const results = searchErrors(query, projectPath);
        const topResults = results.slice(0, limit);

        return {
          query,
          totalFound: results.length,
          results: topResults.map(r => ({
            type: r.type,
            scope: r.scope,
            score: r.score,
            timestamp: new Date(r.data.timestamp).toISOString(),
            summary: r.type === 'failure' 
              ? `${r.data.toolName}: ${r.data.errorMessage.substring(0, 100)}...`
              : r.type === 'experience'
              ? r.data.description.substring(0, 100)
              : r.data.errorDescription.substring(0, 100) + '...',
            solution: r.data.solution || r.data.alternative || 'No solution recorded yet',
            tags: r.data.tags || [],
            resolved: r.data.resolved || false,
          })),
        };
      },
    });
  });

  // Tool: report_error_solution (unchanged)
  ctx.effect(() => {
    return tools.register({
      name: 'report_error_solution',
      description: 'Record a user-reported error and its solution for future reference. Use this when you solve an error to help prevent it in the future.',
      parameters: {
        type: 'object',
        properties: {
          errorDescription: { type: 'string', description: 'Description of the error encountered' },
          solution: { type: 'string', description: 'How the error was solved' },
          errorContext: { type: 'string', description: 'Optional context about when/why the error occurred' },
          tags: { type: 'string', description: 'Optional tags for categorization' },
          relatedFailureId: { type: 'string', description: 'Optional ID of a related auto-recorded failure' },
        },
        required: ['errorDescription', 'solution'],
        additionalProperties: true,
      },
      output: {
        schema: { type: 'object' },
        render: (args, value) => [{ type: 'text', text: value.message || (value.success ? 'Report saved' : 'Failed to save report') }],
      },
      execute: async ({ errorDescription, solution, errorContext, tags, relatedFailureId }, exec) => {
        await globalDomainReady;
        if (!userReportsTable) {
          return { error: 'Database not ready' };
        }

        const reportId = generateId('report');
        const report = {
          id: reportId,
          timestamp: Date.now(),
          sessionId: exec.agent?.id || 'unknown',
          errorDescription,
          solution,
          errorContext,
          tags: tags || [],
          relatedFailureId,
        };

        await userReportsTable.put(reportId, report);

        // Update related failure if provided
        if (relatedFailureId && failuresTable) {
          const failure = failuresTable.get(relatedFailureId);
          if (failure) {
            await failuresTable.put(relatedFailureId, {
              ...failure,
              solution,
              resolved: true,
              tags: [...(failure.tags || []), ...(tags || [])],
            });
          }
        }

        console.log(`[learn-from-failure] Solution recorded: ${reportId}`);
        return {
          success: true,
          reportId,
          message: 'Solution recorded successfully',
        };
      },
    });
  });

  // Tool: cleanup_temp_files (unchanged)
  ctx.effect(() => {
    return tools.register({
      name: 'cleanup_temp_files',
      description: 'Manually trigger cleanup of temporary and debug files in the working directory. Automatically runs at session end.',
      parameters: {
        type: 'object',
        properties: {
          workingDir: { type: 'string', description: 'Directory to clean (defaults to current working directory)' },
        },
        required: [],
        additionalProperties: true,
      },
      output: {
        schema: { type: 'object' },
        render: (args, value) => [{ type: 'text', text: value.error ? `Cleanup failed: ${value.error}` : `Cleaned ${value.cleanedFiles} files (${value.totalSize} bytes)` }],
      },
      execute: async ({ workingDir }, exec) => {
        await globalDomainReady;
        if (!cleanupRecordsTable) {
          return { error: 'Database not ready' };
        }

        let targetDir = workingDir;
        let sessionId = 'manual';
        
        if (!targetDir && exec.agent) {
          const session = ctx.sessions.get(exec.agent.id);
          if (session) {
            targetDir = ctx.workingDirectory.get(session);
          }
          sessionId = exec.agent.id;
        }
        
        targetDir = targetDir || process.cwd();
        const cleaned = await cleanupTempFiles(targetDir, sessionId);

        return {
          success: true,
          cleanedFiles: cleaned.length,
          totalSize: cleaned.reduce((sum, item) => sum + item.size, 0),
          files: cleaned.map(c => c.file),
        };
      },
    });
  });

  // NEW Tool: record_experience
  ctx.effect(() => {
    return tools.register({
      name: 'record_experience',
      description: `Record a success or failure experience for future reference. Use this to build a knowledge base of what works and what doesn't.
      
Call this tool when:
- You successfully solve a problem (type: 'success')
- You discover something that doesn't work (type: 'failure')
- You complete a successful baseline/milestone (type: 'success', include baseline field)
- You learn project-specific knowledge (scope: 'project')

IMPORTANT: When using workarounds or temporary solutions, you MUST set solutionType to 'temporary' or 'workaround' and provide the rootCause. Example workarounds include:
- Using try-catch to ignore errors
- Creating empty/fake files
- Disabling validation checks
- Starting over / rewriting from scratch (instead of building on existing baseline)`,
      parameters: {
        type: 'object',
        properties: {
          type: { type: 'string', description: 'Whether this is a success or failure experience' },
          scope: { type: 'string', description: 'Global (applies everywhere) or project-specific knowledge' },
          description: { type: 'string', description: 'Clear description of what happened or what you learned' },
          context: { type: 'string', description: 'Additional context: what you were doing, why it matters' },
          tags: { type: 'string', description: 'Tags for categorization' },
          solutionType: { type: 'string', description: 'Type of solution' },
          rootCause: { type: 'string', description: 'WHY the problem occurred' },
          whyItHappened: { type: 'string', description: 'Deeper explanation of the cause' },
          alternative: { type: 'string', description: 'Better alternative approach' },
          baseline: { type: 'string', description: 'Baseline/version identifier for successful milestones' },
        },
        required: ['type', 'scope', 'description'],
        additionalProperties: true,
      },
      output: {
        schema: { type: 'object' },
        render: (args, value) => [{ type: 'text', text: value.message || value.error || 'Experience saved' }],
      },
      execute: async ({ type, scope, description, context, tags, solutionType, rootCause, whyItHappened, alternative, baseline }, exec) => {
        await globalDomainReady;
        
        // Get agent from execution context (not ctx.agent!)
        const agent = exec.agent;
        if (!agent) {
          return { error: 'No agent context in tool execution' };
        }
        
        // Get session from agent ID
        const session = ctx.sessions.get(agent.id);
        if (!session) {
          return { error: 'Could not find session for current agent' };
        }
        
        // Get working directory from session
        const projectPath = ctx.workingDirectory.get(session);
        if (!projectPath) {
          return { error: 'Could not determine working directory' };
        }

        // Parse tags: accept string (comma-separated) or array
        let tagArray = [];
        if (typeof tags === 'string') {
          tagArray = tags.split(',').map(t => t.trim()).filter(Boolean);
        } else if (Array.isArray(tags)) {
          tagArray = tags;
        }

        // Detect workaround patterns in description
        const suspectedWorkaround = detectWorkaround(description) || detectWorkaround(context || '');
        
        // Warn if looks like workaround but not marked
        if (suspectedWorkaround && solutionType !== 'workaround' && solutionType !== 'temporary') {
          console.warn('[learn-from-failure] [WARNING] Possible workaround detected but not marked as such');
        }

        // Require rootCause for workarounds/temporary
        if ((solutionType === 'workaround' || solutionType === 'temporary') && !rootCause) {
          return {
            error: 'rootCause is required for workaround or temporary solutions',
            hint: 'Please explain WHY this problem occurred, not just HOW you bypassed it',
          };
        }

        const expId = generateId('exp');
        const experience = {
          id: expId,
          timestamp: Date.now(),
          sessionId: agent?.id || 'unknown',
          type,
          scope,
          ...(scope === 'project' && { projectPath: resolve(projectPath || process.cwd()) }),
          description,
          context,
          tags: tagArray,  // Now guaranteed to be an array
          ...(solutionType && { solutionType }),
          ...(rootCause && { rootCause }),
          ...(whyItHappened && { whyItHappened }),
          ...(alternative && { alternative }),
          isTemporary: solutionType === 'temporary',
          ...(baseline && { baseline }),
        };

        // Store in appropriate domain
        if (scope === 'global') {
          if (!globalExperiencesTable) {
            return { error: 'Global experiences table not ready' };
          }
          await globalExperiencesTable.put(expId, experience);
          console.log(`[learn-from-failure] [OK] Recorded global ${type} experience: ${expId}`);
          
          // Persist to file immediately
          try {
            const storagePaths = getGlobalStoragePath();
            const allData = {};
            for (const [k, v] of globalExperiencesTable.entries()) {
              allData[k] = v;
            }
            await saveToFile(storagePaths.experiences, allData);
            console.log(`[learn-from-failure] [OK] Persisted ${Object.keys(allData).length} global experiences to file`);
          } catch (err) {
            console.error('[learn-from-failure] [ERROR] Failed to persist global experiences:', err);
          }
          
          const result = {
            success: true,
            experienceId: expId,
            message: '[OK] 已记录在全局经验中',
          };
          
          if (suspectedWorkaround && solutionType !== 'workaround') {
            result.warning = '[WARNING] This looks like a workaround. Consider marking solutionType as "workaround"';
          }
          
          return result;
        } else {
          // Project scope
          const projDomain = await getProjectDomain(projectPath || process.cwd());
          if (!projDomain) {
            return { error: 'Failed to open project domain' };
          }
          
          const projExpTable = projDomain.table('experiences');
          await projExpTable.put(expId, experience);
          console.log(`[learn-from-failure] [OK] Recorded project ${type} experience: ${expId}`);
          
          // Persist to file immediately
          try {
            // Emergency trace: write BEFORE any logic
            const traceDir = join(resolve(projectPath || process.cwd()), '.experiences');
            await fs.mkdir(traceDir, { recursive: true });
            await fs.writeFile(join(traceDir, 'trace.txt'), `[${new Date().toISOString()}] Persistence code reached\n`, { flag: 'a' });
            
            const storagePaths = getProjectStoragePath(resolve(projectPath || process.cwd()));
            const allData = {};
            for (const [k, v] of projExpTable.entries()) {
              allData[k] = v;
            }
            await saveToFile(storagePaths.experiences, allData);
            console.log(`[learn-from-failure] [OK] Persisted ${Object.keys(allData).length} project experiences to file`);
          } catch (err) {
            console.error('[learn-from-failure] [ERROR] Failed to persist project experiences:', err);
            // Try to write error trace
            try {
              const traceDir = join(resolve(projectPath || process.cwd()), '.experiences');
              await fs.mkdir(traceDir, { recursive: true });
              await fs.writeFile(join(traceDir, 'error-trace.txt'), `[${new Date().toISOString()}] ${err.message}\n${err.stack}\n\n`, { flag: 'a' });
            } catch {}
          }
          
          let msg = '[OK] 已记录在项目经验中';
          if (solutionType === 'temporary') {
            msg += '，标记为临时方案';
          }
          
          const result = {
            success: true,
            experienceId: expId,
            message: msg,
            projectPath: experience.projectPath,
          };
          
          if (suspectedWorkaround && solutionType !== 'workaround') {
            result.warning = '[WARNING] This looks like a workaround. Consider marking solutionType as "workaround"';
          }
          
          return result;
        }
      },
    });
  });

  // NEW Tool: search_experience
  ctx.effect(() => {
    return tools.register({
      name: 'search_experience',
      description: 'Search both global and project-specific experiences (success & failure learnings). Project experiences are prioritized over global.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query: keywords, tags, or concepts' },
          scope: { type: 'string', description: 'Search scope' },
          limit: { type: 'string', description: 'Maximum results to return' },
        },
        required: ['query'],
        additionalProperties: true,
      },
      output: {
        schema: { type: 'object' },
        render: (args, value) => {
          console.log('[search_experience] Render received:', JSON.stringify(value));
          return [{ type: 'text', text: `Found ${value?.totalFound ?? 'unknown'} experience(s) for "${args.query}"` }];
        },
      },
      execute: async ({ query, scope = 'all', limit = 5 }, exec) => {
        await globalDomainReady;
        
        let projectPath;
        if (exec.agent) {
          const session = ctx.sessions.get(exec.agent.id);
          if (session) {
            projectPath = ctx.workingDirectory.get(session);
          }
        }
        
        // Ensure project domain is loaded before searching
        if (projectPath && (scope === 'project' || scope === 'all')) {
          await getProjectDomain(projectPath);
        }
        
        const results = searchErrors(query, scope === 'project' || scope === 'all' ? projectPath : null);
        
        // Filter by scope
        const filtered = scope === 'all' 
          ? results 
          : results.filter(r => r.scope === scope);
        
        const topResults = filtered.slice(0, limit);

        return {
          query,
          scope,
          totalFound: filtered.length,
          results: topResults.map(r => {
            const result = {
              type: r.data.type || r.type,
              scope: r.scope,
              score: r.score,
              timestamp: new Date(r.data.timestamp).toISOString(),
              description: r.data.description || r.data.errorDescription || r.data.errorMessage,
              tags: r.data.tags || [],
              isTemporary: r.data.isTemporary || false,
            };
            
            // Only add optional fields if they exist
            if (r.data.context) result.context = r.data.context;
            if (r.data.solutionType) result.solutionType = r.data.solutionType;
            if (r.data.rootCause) result.rootCause = r.data.rootCause;
            if (r.data.alternative) result.alternative = r.data.alternative;
            if (r.data.baseline) result.baseline = r.data.baseline;
            
            return result;
          }),
        };
      },
    });
  });

  // NEW Tool: list_temporary_solutions
  ctx.effect(() => {
    return tools.register({
      name: 'list_temporary_solutions',
      description: 'List all temporary solutions that need review before final delivery. Use this during code review or before shipping.',
      parameters: {
        type: 'object',
        properties: {
          scope: { type: 'string' },
        },
        required: [],
        additionalProperties: true,
      },
      output: {
        schema: { type: 'object' },
        render: (args, value) => [{ type: 'text', text: `${value.totalTemporary} temporary solution(s) need review` }],
      },
      execute: async ({ scope = 'all' }, exec) => {
        await globalDomainReady;
        
        const tempSolutions = [];
        let projectPath;
        if (exec.agent) {
          const session = ctx.sessions.get(exec.agent.id);
          if (session) {
            projectPath = ctx.workingDirectory.get(session);
          }
        }

        // Global temporary solutions
        if ((scope === 'global' || scope === 'all') && globalExperiencesTable) {
          for (const [id, exp] of globalExperiencesTable.entries()) {
            if (exp.isTemporary || exp.solutionType === 'temporary') {
              tempSolutions.push({ ...exp, scope: 'global' });
            }
          }
        }

        // Project temporary solutions
        if ((scope === 'project' || scope === 'all') && projectPath) {
          const projDomain = projectDomains.get(resolve(projectPath));
          if (projDomain) {
            const projExpTable = projDomain.table('experiences');
            for (const [id, exp] of projExpTable.entries()) {
              if (exp.isTemporary || exp.solutionType === 'temporary') {
                tempSolutions.push({ ...exp, scope: 'project' });
              }
            }
          }
        }

        return {
          totalTemporary: tempSolutions.length,
          temporarySolutions: tempSolutions.map(exp => ({
            id: exp.id,
            scope: exp.scope,
            timestamp: new Date(exp.timestamp).toISOString(),
            description: exp.description,
            rootCause: exp.rootCause,
            alternative: exp.alternative,
            tags: exp.tags,
          })),
          warning: tempSolutions.length > 0 
            ? '[WARNING] These temporary solutions need review before final delivery' 
            : undefined,
        };
      },
    });
  });

  // System prompt injection - Encourage model to record experiences
  ctx.effect(() => {
    return systemPrompt.section({
      name: 'learn-from-failure-lessons',
      order: (systemPrompt.getSectionOrder?.('rules') ?? 100) + 1,
      text: () => {
        if (!globalExperiencesTable) return '';
        
        // Get recent patterns and experiences
        const recentPatterns = patternsTable 
          ? Array.from(patternsTable.entries())
              .map(([sig, value]) => value)
              .filter(p => Date.now() - p.lastSeen < 30 * 24 * 60 * 60 * 1000) // Last 30 days
              .filter(p => p.occurrenceCount > 2)
              .sort((a, b) => b.occurrenceCount - a.occurrenceCount)
              .slice(0, 5)
          : [];
        
        const recentExperiences = globalExperiencesTable
          ? Array.from(globalExperiencesTable.entries())
              .map(([id, exp]) => exp)
              .sort((a, b) => b.timestamp - a.timestamp)
              .slice(0, 10)
          : [];
        
        const sections = [];
        
        // Core guidance
        sections.push(`<learn_from_failure>
## Experience Learning System

### BEFORE Acting on Errors or Problems
When you encounter:
- Tool execution errors
- User-reported issues
- Build/test failures
- Unexpected behavior
- Need to fix bugs

**FIRST: Search historical experiences**
\`\`\`javascript
search_experience({ 
  query: "your error keyword or problem type",
  scope: "all", // searches both global and project
  limit: 5 
})
\`\`\`

**WHY**: You may have solved this exact problem before. Reuse proven solutions instead of trying new approaches.

### Recording Success (Build on Victories)
When you successfully:
- Fix a bug
- Implement a feature
- Complete a milestone
- Solve a complex problem

**RECORD IT as a baseline:**
\`\`\`javascript
record_experience({
  type: "success",
  scope: "project", // or "global" for universal lessons
  description: "What you accomplished",
  baseline: "v1.2.0", // Version/checkpoint name
  context: "Why this approach worked",
  tags: ["feature", "auth", "security"]
})
\`\`\`

### Recording Failures (Learn the Root Cause)
When you encounter errors, **identify WHY it happened**, not just how you bypassed it:

**Format: 报错-由于-解决**
- 报错：[Exact error message or symptom]
- 由于：[WHY it happened - the root cause]
- 解决：[How you fixed the ROOT CAUSE]

\`\`\`javascript
record_experience({
  type: "failure",
  scope: "global",
  description: "报错：ModuleNotFoundError: No module named 'numpy'",
  rootCause: "由于：Virtual environment not activated, using system Python",
  alternative: "解决：Activated venv with 'source venv/bin/activate' before pip install",
  solutionType: "root_cause", // NOT "temporary" or "workaround"
  tags: ["python", "dependencies", "environment"]
})
\`\`\`

### Workarounds Must Declare Root Cause
If you bypass a problem without fixing it:

\`\`\`javascript
record_experience({
  type: "success",
  scope: "project",
  description: "Bypassed CORS with development proxy",
  solutionType: "workaround", // or "temporary"
  rootCause: "Backend API missing Access-Control-Allow-Origin headers",
  alternative: "Proper fix: Configure CORS on backend server",
  tags: ["cors", "workaround", "api"]
})
\`\`\`

**solutionType enforcement:**
- \`root_cause\`: Fixed the underlying problem
- \`workaround\`: Bypassed the problem, needs proper fix later
- \`temporary\`: Quick fix, must revisit before production

**Required**: \`rootCause\` is MANDATORY for workarounds and temporary solutions.

### Anti-Patterns (DO NOT DO)
- Using try-catch to ignore errors
- Creating fake/empty files to satisfy checks
- Disabling validation or security
- Starting over when encountering small issues
- Commenting out error-reporting code
- **BLIND FIXING**: Making changes without understanding the root cause

**Instead**: Identify and fix the root cause.

### Debugging Methodology (CRITICAL)
When encountering persistent errors:

1. **STOP after 2-3 failed attempts** - Do NOT keep trying variations
2. **Step back and analyze**:
   - What is the COMPLETE data flow?
   - What are ALL the assumptions?
   - What evidence do I have vs. what am I guessing?
3. **Check the ENTIRE system**:
   - Read related code in context
   - Trace execution path from start to end
   - Verify data structures and types
4. **Add diagnostics BEFORE changing logic**:
   - Console logs at key points
   - File-based logs if console unavailable
   - Return intermediate values for inspection
5. **If still blocked, explain the situation to the user** with:
   - What you tried
   - What evidence you collected
   - What you still don't understand

**Never**: Guess → Modify → Test → Repeat without analysis.`);


        // Show recent patterns if any
        if (recentPatterns.length > 0) {
          sections.push(`\n### Recent Error Patterns (Last 30 days, >2 occurrences)
${recentPatterns.map((p, i) => `${i + 1}. **${p.signature}** - ${p.occurrenceCount} times (last: ${new Date(p.lastSeen).toLocaleDateString()})`).join('\n')}`);
        }
        
        // Show recent global experiences
        if (recentExperiences.length > 0) {
          sections.push(`\n### Recent Global Experiences (Latest ${Math.min(10, recentExperiences.length)})
${recentExperiences.slice(0, 5).map((exp, i) => {
            const icon = exp.type === 'success' ? '[SUCCESS]' : '[FAILURE]';
            const temp = exp.isTemporary ? ' [TEMPORARY]' : '';
            return `${i + 1}. ${icon} ${exp.description}${temp}
   ${exp.rootCause ? `Root: ${exp.rootCause.substring(0, 80)}${exp.rootCause.length > 80 ? '...' : ''}` : ''}
   Tags: ${exp.tags?.join(', ') || 'none'}`;
          }).join('\n\n')}`);
        }
        
        sections.push('\n</learn_from_failure>');
        
        return sections.join('\n');
      },
    });
  });

  // Expose service API
  ctx.provide('learnFromFailure', {
    getFailures: () => {
      if (!failuresTable) return [];
      return Array.from(failuresTable.entries()).map(([id, value]) => value);
    },
    getPatterns: () => {
      if (!patternsTable) return [];
      return Array.from(patternsTable.entries()).map(([sig, value]) => value);
    },
    getUserReports: () => {
      if (!userReportsTable) return [];
      return Array.from(userReportsTable.entries()).map(([id, value]) => value);
    },
    getCleanupRecords: () => {
      if (!cleanupRecordsTable) return [];
      return Array.from(cleanupRecordsTable.entries()).map(([id, value]) => value);
    },
    getGlobalExperiences: () => {
      if (!globalExperiencesTable) return [];
      return Array.from(globalExperiencesTable.entries()).map(([id, value]) => value);
    },
    getProjectExperiences: (projectPath) => {
      const normalized = resolve(projectPath || process.cwd());
      if (!projectDomains.has(normalized)) return [];
      const domain = projectDomains.get(normalized);
      const table = domain.table('experiences');
      return Array.from(table.entries()).map(([id, value]) => value);
    },
    getStats: () => {
      if (!failuresTable || !patternsTable) {
        return { totalFailures: 0, totalPatterns: 0, totalReports: 0, totalExperiences: 0, topPatterns: [] };
      }
      
      const patterns = Array.from(patternsTable.entries()).map(([sig, value]) => value);
      return {
        totalFailures: failuresTable.size,
        totalPatterns: patternsTable.size,
        totalReports: userReportsTable?.size || 0,
        totalCleanups: cleanupRecordsTable?.size || 0,
        totalGlobalExperiences: globalExperiencesTable?.size || 0,
        topPatterns: patterns.sort((a, b) => b.occurrenceCount - a.occurrenceCount).slice(0, 10),
      };
    },
    searchErrors: (query, projectPath) => searchErrors(query, projectPath),
  });

  // Register commands (all use lff- prefix)
  if (commands) {
    
  // ========================================
  // Statistics & Viewing Commands
  // ========================================

  // /lff-stats - Overall statistics
  commands.register({
    name: 'lff-stats',
    description: '显示总体统计信息',
    handler: async () => {
      try {
        await globalDomainReady;
        
        const stats = {
          failures: failuresTable?.size || 0,
          patterns: patternsTable?.size || 0,
          reports: userReportsTable?.size || 0,
          globalExperiences: globalExperiencesTable?.size || 0,
        };

        const patterns = patternsTable 
          ? Array.from(patternsTable.entries())
              .map(([sig, value]) => value)
              .sort((a, b) => b.occurrenceCount - a.occurrenceCount)
              .slice(0, 10)
          : [];

        const recentFailures = failuresTable
          ? Array.from(failuresTable.entries())
              .map(([id, value]) => value)
              .sort((a, b) => b.timestamp - a.timestamp)
              .slice(0, 5)
          : [];

        const lines = [
          '=== 总体统计 ===',
          `失败记录: ${stats.failures}`,
          `错误模式: ${stats.patterns}`,
          `用户报告: ${stats.reports}`,
          `全局经验: ${stats.globalExperiences}`,
          '',
          `=== 高频错误模式 (Top ${patterns.length}) ===`,
          patterns.length > 0 
            ? patterns.map((p, i) => `${i + 1}. ${p.signature} - 出现 ${p.occurrenceCount} 次`).join('\n')
            : '暂无数据',
          '',
          `=== 最近失败 (最新 ${recentFailures.length} 条) ===`,
          recentFailures.length > 0 
            ? recentFailures.map(f => `- [${f.errorType}] ${f.toolName}: ${f.errorMessage.substring(0, 60)}${f.errorMessage.length > 60 ? '...' : ''}`).join('\n')
            : '暂无数据',
        ];

        return { kind: 'success', text: lines.join('\n') };
      } catch (error) {
        return { kind: 'error', text: `执行失败: ${error.message}` };
      }
    },
  });

  // /lff-global - Show global experiences
  commands.register({
    name: 'lff-global',
    description: '显示全局经验',
    handler: async () => {
      try {
        await globalDomainReady;
        
        if (!globalExperiencesTable || globalExperiencesTable.size === 0) {
          return { kind: 'success', text: '暂无全局经验记录' };
        }

        const experiences = Array.from(globalExperiencesTable.entries())
          .map(([id, exp]) => exp)
          .sort((a, b) => b.timestamp - a.timestamp);

        const lines = [
          `=== 全局经验 (${experiences.length} 条) ===`,
          '',
          ...experiences.map((exp, i) => [
            `${i + 1}. [${exp.type.toUpperCase()}] ${exp.description}`,
            `   时间: ${new Date(exp.timestamp).toLocaleString('zh-CN')}`,
            exp.tags?.length > 0 ? `   标签: ${exp.tags.join(', ')}` : null,
            exp.rootCause ? `   根因: ${exp.rootCause}` : null,
            exp.alternative ? `   建议: ${exp.alternative}` : null,
          ].filter(Boolean).join('\n')),
        ];

        return { kind: 'success', text: lines.join('\n') };
      } catch (error) {
        return { kind: 'error', text: `执行失败: ${error.message}` };
      }
    },
  });

  // /lff-project - Show project experiences
  commands.register({
    name: 'lff-project',
    description: '显示当前项目经验（可选：提供项目路径）',
    input: {
      hint: '[项目路径]（可选，默认使用当前会话工作目录）',
    },
    handler: async ({ agent, rawInput }) => {
      try {
        // Use provided path or get from current session
        let projectPath;
        if (rawInput.trim()) {
          projectPath = rawInput.trim();
        } else {
          const session = ctx.sessions.get(agent.id);
          if (session) {
            projectPath = ctx.workingDirectory.get(session);
          } else {
            projectPath = ctx.workingDirectory.defaultDirectory;
          }
        }
        
        console.log('[lff-project] Using project path:', projectPath);
        console.log('[lff-project] Agent ID:', agent.id);
        
        const projDomain = await getProjectDomain(projectPath);
        
        if (!projDomain) {
          console.error('[lff-project] getProjectDomain returned null');
          return { 
            kind: 'error', 
            text: `无法打开项目域\n路径: ${projectPath}\n\n可能原因：\n1. 目录权限不足\n2. .experiences/ 创建失败\n3. Storage Domain 初始化错误\n\n请运行 /lff-debug 查看详细状态\n\n提示：可以指定路径: /lff-project D:\\your\\project\\path` 
          };
        }

        const projExpTable = projDomain.table('experiences');
        
        if (projExpTable.size === 0) {
          return { kind: 'success', text: `当前项目暂无经验记录\n路径: ${projectPath}\n\n提示：使用 record_experience 工具并设置 scope='project' 来记录项目经验` };
        }

        const experiences = Array.from(projExpTable.entries())
          .map(([id, exp]) => exp)
          .sort((a, b) => b.timestamp - a.timestamp);

        const lines = [
          `=== 项目经验 (${experiences.length} 条) ===`,
          `路径: ${projectPath}`,
          '',
          `路径: ${projectPath}`,
          '',
          ...experiences.map((exp, i) => [
            `${i + 1}. [${exp.type.toUpperCase()}] ${exp.description}`,
            `   时间: ${new Date(exp.timestamp).toLocaleString('zh-CN')}`,
            exp.tags?.length > 0 ? `   标签: ${exp.tags.join(', ')}` : null,
            exp.rootCause ? `   根因: ${exp.rootCause}` : null,
            exp.alternative ? `   建议: ${exp.alternative}` : null,
          ].filter(Boolean).join('\n')),
        ];

        return { kind: 'success', text: lines.join('\n') };
      } catch (error) {
        console.error('[lff-project] Command error:', error);
        return { kind: 'error', text: `执行失败: ${error.message}\n\n${error.stack}` };
      }
    },
  });

  // /lff-failures - Show recent failures
  commands.register({
    name: 'lff-failures',
    description: '显示最近的失败记录',
    handler: async ({ rawInput }) => {
      try {
        await globalDomainReady;
        
        const limit = parseInt(rawInput?.trim()) || 10;
        
        if (!failuresTable || failuresTable.size === 0) {
          return { kind: 'success', text: '暂无失败记录' };
        }

        const failures = Array.from(failuresTable.entries())
          .map(([id, f]) => f)
          .sort((a, b) => b.timestamp - a.timestamp)
          .slice(0, limit);

        const lines = [
          `=== 最近失败 (最新 ${failures.length} 条) ===`,
          '',
          ...failures.map((f, i) => [
            `${i + 1}. [${f.errorType.toUpperCase()}] ${f.toolName}`,
            `   错误: ${f.errorMessage}`,
            `   时间: ${new Date(f.timestamp).toLocaleString('zh-CN')}`,
            `   重复: ${f.recurrenceCount} 次`,
            f.resolved ? '   状态: 已解决 ✓' : '   状态: 未解决',
          ].join('\n')),
        ];

        return { kind: 'success', text: lines.join('\n') };
      } catch (error) {
        return { kind: 'error', text: `执行失败: ${error.message}` };
      }
    },
  });

  // /lff-patterns - Show error patterns
  commands.register({
    name: 'lff-patterns',
    description: '显示高频错误模式',
    handler: async ({ rawInput }) => {
      try {
        await globalDomainReady;
        
        const limit = parseInt(rawInput?.trim()) || 20;
        
        if (!patternsTable || patternsTable.size === 0) {
          return { kind: 'success', text: '暂无错误模式' };
        }

        const patterns = Array.from(patternsTable.entries())
          .map(([sig, p]) => p)
          .sort((a, b) => b.occurrenceCount - a.occurrenceCount)
          .slice(0, limit);

        const lines = [
          `=== 高频错误模式 (Top ${patterns.length}) ===`,
          '',
          ...patterns.map((p, i) => [
            `${i + 1}. ${p.signature}`,
            `   出现次数: ${p.occurrenceCount}`,
            `   最后出现: ${new Date(p.lastSeen).toLocaleString('zh-CN')}`,
            p.commonSolutions?.length > 0 ? `   常见方案: ${p.commonSolutions.join('; ')}` : null,
          ].filter(Boolean).join('\n')),
        ];

        return { kind: 'success', text: lines.join('\n') };
      } catch (error) {
        return { kind: 'error', text: `执行失败: ${error.message}` };
      }
    },
  });

  // ========================================
  // Recording & Management Commands
  // ========================================

  // /lff-record - Record new experience
  commands.register({
    name: 'lff-record',
    description: '记录新经验（用法：描述 #success/#failure #global/#project #tag1,tag2）',
    input: {
      hint: '经验描述（可选：添加 #success #global #tag1,tag2）',
    },
    handler: async ({ agent, rawInput }) => {
      try {
        if (!rawInput || rawInput.trim() === '') {
          return {
            kind: 'error',
            text: '请提供经验描述\n\n用法示例:\n  /lff-record 成功解决了文件权限问题 #success #global #file,permission\n  /lff-record 发现性能瓶颈在数据库查询 #failure #project',
          };
        }

        const input = rawInput.trim();
        const typeMatch = input.match(/#(success|failure)/);
        const scopeMatch = input.match(/#(global|project)/);
        const tagsMatch = input.match(/#([\w,]+)$/);
        
        const type = typeMatch ? typeMatch[1] : 'success';
        const scope = scopeMatch ? scopeMatch[1] : 'global';
        const tags = tagsMatch && !['success', 'failure', 'global', 'project'].includes(tagsMatch[1])
          ? tagsMatch[1].split(',').map(t => t.trim())
          : [];
        
        const description = input
          .replace(/#success/g, '')
          .replace(/#failure/g, '')
          .replace(/#global/g, '')
          .replace(/#project/g, '')
          .replace(/#[\w,]+$/g, '')
          .trim();

        if (!description) {
          return { kind: 'error', text: '描述不能为空' };
        }

        // Get project path from session if scope is 'project'
        let projectPath;
        if (scope === 'project') {
          const session = ctx.sessions.get(agent.id);
          projectPath = session ? ctx.workingDirectory.get(session) : ctx.workingDirectory.defaultDirectory;
        }

        const expId = generateId('exp');
        const experience = {
          id: expId,
          timestamp: Date.now(),
          sessionId: agent.id,
          type,
          scope,
          projectPath: projectPath ? resolve(projectPath) : undefined,
          description,
          tags,
        };

        if (scope === 'global') {
          if (!globalExperiencesTable) {
            return { kind: 'error', text: '全局经验表未就绪' };
          }
          await globalExperiencesTable.put(expId, experience);
          return {
            kind: 'success',
            text: `已记录在全局经验中\n\nID: ${expId}\n类型: ${type}\n描述: ${description}\n标签: ${tags.join(', ') || '无'}`,
          };
        } else {
          const projPath = currentAgent?.cwd || process.cwd();
          const projDomain = await getProjectDomain(projPath);
          if (!projDomain) {
            return { kind: 'error', text: '无法打开项目域' };
          }
          const projExpTable = projDomain.table('experiences');
          await projExpTable.put(expId, experience);
          return {
            kind: 'success',
            text: `已记录在项目经验中\n\nID: ${expId}\n类型: ${type}\n路径: ${experience.projectPath}\n描述: ${description}\n标签: ${tags.join(', ') || '无'}`,
          };
        }
      } catch (error) {
        return { kind: 'error', text: `执行失败: ${error.message}` };
      }
    },
  });

  // /lff-temp - Show temporary solutions
  commands.register({
    name: 'lff-temp',
    description: '列出所有临时方案（需要在交付前审查）',
    input: {
      hint: '[项目路径]（可选，默认使用当前会话工作目录）',
    },
    handler: async ({ agent, rawInput }) => {
      try {
        await globalDomainReady;
        
        const tempSolutions = [];
        
        // Get project path from input or session
        let projectPath;
        if (rawInput.trim()) {
          projectPath = rawInput.trim();
        } else {
          const session = ctx.sessions.get(agent.id);
          projectPath = session ? ctx.workingDirectory.get(session) : ctx.workingDirectory.defaultDirectory;
        }

        // Global
        if (globalExperiencesTable) {
          for (const [id, exp] of globalExperiencesTable.entries()) {
            if (exp.isTemporary || exp.solutionType === 'temporary' || exp.solutionType === 'workaround') {
              tempSolutions.push({ ...exp, scope: 'global' });
            }
          }
        }

        // Project
        const projDomain = projectDomains.get(resolve(projectPath));
        if (projDomain) {
          const projExpTable = projDomain.table('experiences');
          for (const [id, exp] of projExpTable.entries()) {
            if (exp.isTemporary || exp.solutionType === 'temporary' || exp.solutionType === 'workaround') {
              tempSolutions.push({ ...exp, scope: 'project' });
            }
          }
        }

        if (tempSolutions.length === 0) {
          return { kind: 'success', text: '没有临时方案，代码库很健康' };
        }

        const lines = [
          `=== 临时方案 (${tempSolutions.length} 个需要审查) ===`,
          `项目路径: ${projectPath}`,
          '',
          ...tempSolutions.map((exp, i) => [
            `${i + 1}. [${exp.scope.toUpperCase()}] ${exp.description}`,
            `   原因: ${exp.rootCause || '未记录'}`,
            `   建议: ${exp.alternative || '未提供'}`,
          ].join('\n')),
          '',
          '提示: 这些方案在交付前应该被替换为根本解决方案',
        ];

        return { kind: 'success', text: lines.join('\n') };
      } catch (error) {
        return { kind: 'error', text: `执行失败: ${error.message}` };
      }
    },
  });

  // ========================================
  // Search & Query Commands
  // ========================================

  // /lff-search - Search errors and experiences
  commands.register({
    name: 'lff-search',
    description: '搜索错误和经验（用法：/lff-search [关键词]）',
    input: {
      hint: '搜索关键词',
    },
    handler: async ({ agent, rawInput }) => {
      try {
        await globalDomainReady;
        
        if (!rawInput || rawInput.trim() === '') {
          return { kind: 'error', text: '请提供搜索关键词' };
        }

        const query = rawInput.trim().toLowerCase();
        const results = [];

        // Search failures
        if (failuresTable) {
          for (const [id, failure] of failuresTable.entries()) {
            if (failure.errorMessage.toLowerCase().includes(query) ||
                failure.toolName.toLowerCase().includes(query) ||
                failure.errorType.toLowerCase().includes(query)) {
              results.push({
                type: 'failure',
                data: failure,
                score: 1,
              });
            }
          }
        }

        // Search global experiences
        if (globalExperiencesTable) {
          for (const [id, exp] of globalExperiencesTable.entries()) {
            if (exp.description.toLowerCase().includes(query) ||
                exp.tags?.some(t => t.toLowerCase().includes(query))) {
              results.push({
                type: 'experience',
                scope: 'global',
                data: exp,
                score: 1,
              });
            }
          }
        }

        // Search project experiences
        const session = ctx.sessions.get(agent.id);
        const projectPath = session ? ctx.workingDirectory.get(session) : ctx.workingDirectory.defaultDirectory;
        const projDomain = projectDomains.get(resolve(projectPath));
        if (projDomain) {
          const projExpTable = projDomain.table('experiences');
          for (const [id, exp] of projExpTable.entries()) {
            if (exp.description.toLowerCase().includes(query) ||
                exp.tags?.some(t => t.toLowerCase().includes(query))) {
              results.push({
                type: 'experience',
                scope: 'project',
                  data: exp,
                  score: 1,
                });
              }
            }
          }

        if (results.length === 0) {
          return { kind: 'success', text: `未找到匹配 "${query}" 的结果` };
        }

        const lines = [
          `=== 搜索结果 (${results.length} 条) ===`,
          `关键词: ${query}`,
          '',
          ...results.slice(0, 20).map((r, i) => {
            if (r.type === 'failure') {
              return [
                `${i + 1}. [FAILURE] ${r.data.toolName}`,
                `   ${r.data.errorMessage.substring(0, 80)}`,
                `   时间: ${new Date(r.data.timestamp).toLocaleString('zh-CN')}`,
              ].join('\n');
            } else {
              return [
                `${i + 1}. [${r.scope.toUpperCase()} EXP] ${r.data.description}`,
                `   类型: ${r.data.type}`,
                `   时间: ${new Date(r.data.timestamp).toLocaleString('zh-CN')}`,
              ].join('\n');
            }
          }),
        ];

        if (results.length > 20) {
          lines.push('', `... 还有 ${results.length - 20} 条结果未显示`);
        }

        return { kind: 'success', text: lines.join('\n') };
      } catch (error) {
        return { kind: 'error', text: `执行失败: ${error.message}` };
      }
    },
  });

  // ========================================
  // Maintenance & Debug Commands
  // ========================================

  // /lff-debug - Show plugin status
  commands.register({
    name: 'lff-debug',
    description: '显示插件内部状态（调试用）',
    handler: async () => {
      try {
        const debugInfo = [];
        
        debugInfo.push('=== Plugin Status ===');
        debugInfo.push('');
        
        // Check domain status
        let domainStatus = 'pending';
        let domainError = null;
        try {
          await Promise.race([
            globalDomainReady.then(() => { domainStatus = 'ready'; }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 100))
          ]);
        } catch (e) {
          if (e.message === 'timeout') {
            domainStatus = 'pending (timeout after 100ms)';
          } else {
            domainStatus = 'error';
            domainError = e.message;
          }
        }
        
        debugInfo.push(`Global Domain: ${domainStatus}`);
        if (domainError) {
          debugInfo.push(`  Error: ${domainError}`);
        }
        debugInfo.push('');
        
        // Tables
        debugInfo.push('Tables:');
        debugInfo.push(`  - failures: ${!!failuresTable} (size: ${failuresTable?.size ?? 'N/A'})`);
        debugInfo.push(`  - patterns: ${!!patternsTable} (size: ${patternsTable?.size ?? 'N/A'})`);
        debugInfo.push(`  - user_reports: ${!!userReportsTable} (size: ${userReportsTable?.size ?? 'N/A'})`);
        debugInfo.push(`  - cleanup_records: ${!!cleanupRecordsTable} (size: ${cleanupRecordsTable?.size ?? 'N/A'})`);
        debugInfo.push(`  - experiences: ${!!globalExperiencesTable} (size: ${globalExperiencesTable?.size ?? 'N/A'})`);
        debugInfo.push('');
        
        // Services
        debugInfo.push('Services:');
        debugInfo.push(`  - storageDomain: ${!!ctx.storageDomain}`);
        debugInfo.push(`  - systemPrompt: ${!!ctx.systemPrompt}`);
        debugInfo.push(`  - tools: ${!!ctx.tools}`);
        debugInfo.push(`  - commands: ${!!commands}`);
        debugInfo.push('');
        
        // Project domains
        debugInfo.push(`Project Domains: ${projectDomains.size}`);
        for (const [path, domain] of projectDomains) {
          debugInfo.push(`  - ${path}`);
        }
        
        return { kind: 'success', text: debugInfo.join('\n') };
      } catch (error) {
        return { kind: 'error', text: `调试失败: ${error.message}\n${error.stack}` };
      }
    },
  });

  // /lff-clear - Clear all records (with confirmation)
  commands.register({
    name: 'lff-clear',
    description: '清除所有记录（危险操作，需要确认）',
    input: {
      hint: '输入 "CONFIRM" 确认清除',
    },
    handler: async ({ rawInput }) => {
      try {
        if (rawInput?.trim() !== 'CONFIRM') {
          return {
            kind: 'error',
            text: '危险操作！\n\n此操作将清除所有失败记录、错误模式和全局经验。\n\n如需继续，请输入：/lff-clear CONFIRM',
          };
        }

        await globalDomainReady;

        let cleared = 0;

        // Clear failures
        if (failuresTable) {
          const ids = Array.from(failuresTable.keys());
          for (const id of ids) {
            await failuresTable.delete(id);
          }
          cleared += ids.length;
        }

        // Clear patterns
        if (patternsTable) {
          const sigs = Array.from(patternsTable.keys());
          for (const sig of sigs) {
            await patternsTable.delete(sig);
          }
          cleared += sigs.length;
        }

        // Clear user reports
        if (userReportsTable) {
          const ids = Array.from(userReportsTable.keys());
          for (const id of ids) {
            await userReportsTable.delete(id);
          }
          cleared += ids.length;
        }

        // Clear global experiences
        if (globalExperiencesTable) {
          const ids = Array.from(globalExperiencesTable.keys());
          for (const id of ids) {
            await globalExperiencesTable.delete(id);
          }
          cleared += ids.length;
        }

        return { kind: 'success', text: `已清除 ${cleared} 条记录` };
      } catch (error) {
        return { kind: 'error', text: `执行失败: ${error.message}` };
      }
    },
  });


    console.log('[learn-from-failure] Commands registered: lff-stats, lff-global, lff-project, lff-failures, lff-patterns, lff-record, lff-temp, lff-search, lff-debug, lff-clear');
  }

  // Cleanup on dispose
  ctx.on('dispose', async () => {
    if (globalDomain) {
      await globalDomain.close();
      console.log('[learn-from-failure] Global domain closed');
    }
    for (const [path, domain] of projectDomains) {
      await domain.close();
      console.log(`[learn-from-failure] Project domain closed: ${path}`);
    }
  });
}
