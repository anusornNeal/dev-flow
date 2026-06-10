/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Task } from '../types';

export const INITIAL_TASKS: Task[] = [
  {
    id: 'task-1',
    title: 'Implement Room Database Local Cache & Flow Repository in Kotlin',
    description: 'Establish a rock-solid offline persistent database engine for Android. Use Android Room ORM with Kotlin Flow to deliver reactive stream events from cache to view models.',
    status: 'in-progress',
    branch: 'feature/room-kotlin-cache',
    priority: 'high',
    tags: ['android', 'kotlin', 'room', 'database'],
    createdAt: '2026-06-08T01:00:00.000Z',
    updatedAt: '2026-06-08T03:30:00.000Z',
    targetFiles: [
      'app/src/main/java/com/example/devflow/data/local/TaskEntity.kt',
      'app/src/main/java/com/example/devflow/data/local/TaskDao.kt',
      'app/src/main/java/com/example/devflow/data/repository/TaskRepositoryImpl.kt'
    ],
    checklist: [
      { id: 'step-1-1', text: 'Configure TaskEntity class with Room primary keys & dynamic index mapping', completed: true },
      { id: 'step-1-2', text: 'Implement TaskDao interface with dynamic query Flows and upsert transactions', completed: true },
      { id: 'step-1-3', text: 'Complete TaskRepository abstract implementation class wrapping Dao methods', completed: false },
      { id: 'step-1-4', text: 'Establish thorough Local Database offline Unit Tests with Robolectric', completed: false }
    ],
    logs: [
      {
        id: 'log-1',
        timestamp: '2026-06-08T01:00:00.000Z',
        message: 'Mobile Dev task initialized.',
        type: 'create'
      },
      {
        id: 'log-2',
        timestamp: '2026-06-08T03:30:00.000Z',
        message: 'Moved status to In Progress and synced git branch: feature/room-kotlin-cache',
        type: 'move'
      }
    ]
  },
  {
    id: 'task-2',
    title: 'Build Interactive Performance Analytics View with SwiftUI Charts',
    description: 'Design a dashboard screen for iOS client to represent task completion and performance analytics. Apply custom spring transition lines and responsive gestures to interactive nodes.',
    status: 'todo',
    branch: 'feature/swiftui-charts',
    priority: 'high',
    tags: ['ios', 'swift', 'swiftui', 'charts'],
    createdAt: '2026-06-08T02:15:00.000Z',
    updatedAt: '2026-06-08T02:15:00.000Z',
    targetFiles: [
      'ios/DevFlow/Views/AnalyticsDashboardView.swift',
      'ios/DevFlow/Models/StatsModel.swift',
      'ios/DevFlow/Components/RhythmLineChart.swift'
    ],
    checklist: [
      { id: 'step-2-1', text: 'Structure StatsModel data points representing history', completed: true },
      { id: 'step-2-2', text: 'Build line charts and interactive slider gestures using SwiftUI Charts framework', completed: false },
      { id: 'step-2-3', text: 'Tune ease-in-out spring entry animations on view loading transitions', completed: false }
    ],
    logs: [
      {
        id: 'log-3',
        timestamp: '2026-06-08T02:15:00.000Z',
        message: 'Task created from performance log alerts.',
        type: 'create'
      }
    ]
  },
  {
    id: 'task-3',
    title: 'Tune Jetpack Compose Theme & Dynamic Material You Palette',
    description: 'Ensure full support for light/dark theme values mapping correctly on Android 12+. Integrate Edge-to-Edge window insets standard to provide beautiful unified UI borders.',
    status: 'backlog',
    branch: 'feature/compose-theme-tune',
    priority: 'medium',
    tags: ['android', 'kotlin', 'compose', 'ui'],
    createdAt: '2026-06-07T12:00:00.000Z',
    updatedAt: '2026-06-07T12:00:00.000Z',
    targetFiles: [
      'app/src/main/java/com/example/devflow/ui/theme/Theme.kt',
      'app/src/main/java/com/example/devflow/ui/theme/Color.kt'
    ],
    checklist: [
      { id: 'step-3-1', text: 'Map dynamic material colors schema for Android 12+', completed: false },
      { id: 'step-3-2', text: 'Call WindowCompat.setDecorFitsSystemWindows in MainActivity to set system-bar transparency', completed: false },
      { id: 'step-3-3', text: 'Confirm color contrast ratios comply with WCAG standards', completed: false }
    ],
    logs: [
      {
        id: 'log-4',
        timestamp: '2026-06-07T12:00:00.000Z',
        message: 'Task created for scheduling.',
        type: 'create'
      }
    ]
  },
  {
    id: 'task-4',
    title: 'Configure Ktor Native shared HTTP client for Kotlin Multiplatform mobile app',
    description: 'Implement multiplatform network engine setup using expect/actual declarations. Configure JSON format negotiation with Kotlinx Serialization and set strict connection timeout constraints.',
    status: 'done',
    branch: 'feature/kmp-shared-ktor',
    priority: 'low',
    tags: ['kmp', 'kotlin', 'ktor', 'network'],
    createdAt: '2026-06-06T09:00:00.000Z',
    updatedAt: '2026-06-07T15:00:00.000Z',
    targetFiles: [
      'shared/src/commonMain/kotlin/com/example/devflow/network/KmpHttpClient.kt',
      'shared/build.gradle.kts'
    ],
    checklist: [
      { id: 'step-4-1', text: 'Add respective Ktor Client core, logging and serialization dependencies inside shared build.gradle.kts', completed: true },
      { id: 'step-4-2', text: 'Declare KmpHttpClient instance with ContentNegotiation plugin configurator', completed: true },
      { id: 'step-4-3', text: 'Verify cross-platform compatibility test build for Android and iOS targets succeeds', completed: true }
    ],
    logs: [
      {
        id: 'log-5',
        timestamp: '2026-06-06T09:00:00.000Z',
        message: 'KMP backend architecture layout task opened.',
        type: 'create'
      },
      {
        id: 'log-6',
        timestamp: '2026-06-07T15:00:00.000Z',
        message: 'Merged shared-ktor client config into main root. Compile verified on Android & iOS platforms.',
        type: 'edit'
      }
    ]
  }
];
