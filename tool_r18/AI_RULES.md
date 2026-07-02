# AI Rules for Infinio - AI视频快捷生产工具

## Tech Stack Overview

• **Frontend Framework**: React 18 with TypeScript for type-safe development and component-based architecture
• **UI Components**: shadcn/ui library with Tailwind CSS for consistent, accessible design system
• **State Management**: React hooks for local state, with Supabase integration for backend persistence
• **API Integration**: Direct API calls to various AI services (Google Gemini, Doubao Seedream, Vidu, Kling) via proxy functions
• **Build Tool**: Vite for fast development and optimized builds
• **Database**: Supabase PostgreSQL for project persistence and user data management
• **File Storage**: Supabase Storage for generated images and videos
• **Video Generation**: Multi-provider support (Seedance, Vidu, Kling) for AI video synthesis
• **Image Generation**: Gemini and Doubao Seedream for character and scene image generation
• **Deployment**: Vite build with static hosting capabilities

## Library Usage Rules

### UI Components
• Use shadcn/ui components exclusively for all UI elements (Button, Card, Input, etc.)
• Use Lucide React icons for all interface icons
• Use Tailwind CSS for custom styling, following the configured theme in tailwind.config.ts
• Never create custom styled components when shadcn/ui equivalents exist

### Data Management
• Use Supabase client for all database operations
• Use localStorage for client-side persistence of settings and temporary data
• Use React hooks (useState, useEffect, etc.) for component state management
• Implement proper TypeScript interfaces for all data structures

### API Communication
• Use the proxy functions in `/lib/gemini-client.ts` for all AI API calls
• Implement proper error handling with the `friendlyError` utility
• Use the `invokeFunction` helper for calling Supabase edge functions
• Always implement timeout and abort functionality for long-running requests

### File Operations
• Use Supabase Storage for uploading and retrieving generated assets
• Implement proper image compression before uploading using the `compressImage` utility
• Handle both data URLs and storage URLs appropriately in image components
• Use the `ensureStorageUrl` function to manage base64 to URL conversion

### Video and Image Generation
• Use the `callGemini` and `callGeminiStream` functions for all Gemini API interactions
• Implement proper aspect ratio handling for different video formats
• Support multiple video generation providers through the unified video generation interface
• Implement retry logic and error handling for all generation processes

### Accessibility and UX
• Ensure all interactive elements are keyboard accessible
• Implement proper loading states and progress indicators
• Provide clear error messages using the toast notification system
• Follow WCAG guidelines for accessibility

### Code Organization
• Place components in `/src/components` with proper subdirectories
• Place page components in `/src/pages`
• Place utility functions in `/src/lib`
• Use TypeScript interfaces and types consistently
• Follow the existing folder structure and naming conventions