/**
 * Canonical icon set for MCA renderers — Phosphor.
 *
 * Per renderer-ux-guide §4 + decision log (TER-186 / 2026-05-07): the
 * design system uses Phosphor as the icon family. This module is the
 * single point of truth — renderers should import icons from here (or
 * via the `primitives` barrel), never from `phosphor-react-native`
 * directly.
 *
 * Why aliasing instead of renaming JSX usages: the migration from
 * Lucide to Phosphor touches ~70 files. Re-exporting Phosphor's
 * `<Name>Icon` exports under their familiar Lucide names means we only
 * change the import *path* in each file — the JSX (`<Check />`,
 * `<Trash2 />`, `<ChevronRight />`) stays exactly as it was. Future
 * migrations or icon swaps happen here, not across 70+ renderers.
 *
 * The mapping was built by intersecting the icons actually imported
 * in `packages/app/src/components/mca/` against Phosphor 3.0.6's
 * exports. Choices were made by visual + semantic equivalence; e.g.
 * Lucide's `Edit3` → Phosphor's `PencilSimple`, `MoreVertical` →
 * `DotsThreeVertical`, `ChevronRight` → `CaretRight`. When in doubt,
 * compare in the Phosphor catalog at https://phosphoricons.com.
 *
 * Note: Phosphor 3.x marked the no-suffix exports as deprecated in
 * favor of `<Name>Icon`. We import the `*Icon` variants and re-export
 * them under the legacy Lucide names — the deprecation notice does
 * not propagate.
 */

// Direct names (Lucide name === Phosphor name).
export {
  ArchiveIcon as Archive,
  BellIcon as Bell,
  BookIcon as Book,
  BrainIcon as Brain,
  BugIcon as Bug,
  CakeIcon as Cake,
  CalendarIcon as Calendar,
  CameraIcon as Camera,
  CheckIcon as Check,
  CheckCircleIcon as CheckCircle,
  CircleIcon as Circle,
  ClockIcon as Clock,
  CodeIcon as Code,
  CopyIcon as Copy,
  CrownIcon as Crown,
  DatabaseIcon as Database,
  DownloadIcon as Download,
  FileIcon as File,
  FileCodeIcon as FileCode,
  FileImageIcon as FileImage,
  FileTextIcon as FileText,
  FingerprintIcon as Fingerprint,
  FolderIcon as Folder,
  FolderOpenIcon as FolderOpen,
  FolderPlusIcon as FolderPlus,
  GitBranchIcon as GitBranch,
  GitCommitIcon as GitCommit,
  GitForkIcon as GitFork,
  GitMergeIcon as GitMerge,
  GitPullRequestIcon as GitPullRequest,
  GlobeIcon as Globe,
  HashIcon as Hash,
  ImageIcon as Image,
  KeyboardIcon as Keyboard,
  LayoutIcon as Layout,
  LightbulbIcon as Lightbulb,
  LinkIcon as Link,
  ListIcon as List,
  LockIcon as Lock,
  MapPinIcon as MapPin,
  MinusCircleIcon as MinusCircle,
  PaletteIcon as Palette,
  PauseIcon as Pause,
  PhoneIcon as Phone,
  PlayIcon as Play,
  PlusIcon as Plus,
  PowerIcon as Power,
  ShieldIcon as Shield,
  ShieldCheckIcon as ShieldCheck,
  SquareIcon as Square,
  StarIcon as Star,
  TableIcon as Table,
  TagIcon as Tag,
  TerminalIcon as Terminal,
  ThumbsDownIcon as ThumbsDown,
  ThumbsUpIcon as ThumbsUp,
  ToggleLeftIcon as ToggleLeft,
  ToggleRightIcon as ToggleRight,
  UploadIcon as Upload,
  UserIcon as User,
  UserMinusIcon as UserMinus,
  UserPlusIcon as UserPlus,
  UsersIcon as Users,
  VideoIcon as Video,
  XIcon as X,
  XCircleIcon as XCircle,
} from 'phosphor-react-native';

// Mapped (Lucide name → Phosphor equivalent).
export {
  PulseIcon as Activity,
  WarningCircleIcon as AlertCircle,
  ArrowLineDownIcon as ArrowDownToLine,
  ArrowsLeftRightIcon as ArrowRightLeft,
  ProhibitIcon as Ban,
  RobotIcon as Bot,
  BuildingsIcon as Building2,
  CalendarDotIcon as CalendarClock,
  CheckCircleIcon as CheckCircle2,
  CheckSquareOffsetIcon as CheckSquare,
  CaretRightIcon as ChevronRight,
  QuestionIcon as CircleHelp,
  CubeIcon as Component,
  PencilSimpleIcon as Edit3,
  ArrowSquareOutIcon as ExternalLink,
  FileArchiveIcon as FileBox,
  FileTextIcon as FileDiff,
  FileMagnifyingGlassIcon as FileSearch,
  FileXlsIcon as FileSpreadsheet,
  FilmStripIcon as Film,
  FolderSimpleDashedIcon as FolderDown,
  FrameCornersIcon as Frame,
  GitPullRequestIcon as GitPullRequestClosed,
  GitPullRequestIcon as GitPullRequestDraft,
  ClockCounterClockwiseIcon as History,
  HouseIcon as Home,
  StackSimpleIcon as Layers,
  LinkIcon as Link2,
  LinkBreakIcon as Link2Off,
  TreeStructureIcon as ListTree,
  EnvelopeIcon as Mail,
  ArrowsOutIcon as Maximize2,
  ChatCircleIcon as MessageCircle,
  ChatTeardropIcon as MessageSquare,
  MonitorIcon as MonitorPlay,
  DotsThreeVerticalIcon as MoreVertical,
  CursorClickIcon as MousePointer,
  ArrowsOutCardinalIcon as Move,
  MusicNoteIcon as Music,
  MusicNoteIcon as Music2,
  CompassIcon as Navigation,
  PencilSimpleIcon as Pencil,
  PushPinIcon as Pin,
  AirplaneIcon as Plane,
  PowerIcon as PowerOff,
  PresentationChartIcon as Presentation,
  ArrowsClockwiseIcon as RefreshCw,
  ArrowBendUpLeftIcon as Reply,
  ScanIcon as ScanText,
  MagnifyingGlassIcon as Search,
  GearIcon as Settings,
  ShareNetworkIcon as Share2,
  ShieldWarningIcon as ShieldAlert,
  ShieldSlashIcon as ShieldOff,
  SparkleIcon as Sparkles,
  TrashIcon as Trash2,
  TextAaIcon as Type,
  UserGearIcon as UserCog,
  WifiHighIcon as Wifi,
  FlowArrowIcon as Workflow,
  LightningIcon as Zap,
} from 'phosphor-react-native';
