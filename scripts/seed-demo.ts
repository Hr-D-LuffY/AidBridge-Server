// Fills an empty database with realistic demo data (Bangladesh: floods, a cyclone, a fire, a
// landslide) so every screen and endpoint has something to show.
//
//   npm run seed:demo            create the demo data (stops if it is already there)
//   npm run seed:demo -- --reset delete the demo data this script made, then create it again
//
// Everything it creates belongs to the demo accounts below (emails end in @aidbridge.test), and
// --reset only deletes records owned by those accounts — real data is never touched.
//
// Demo logins (all emails end in @aidbridge.test):
//   admin      admin@aidbridge.test       Admin@12345
//   ngo        ngo@aidbridge.test         Ngo@12345
//   volunteer  volunteer@aidbridge.test   Volunteer@123
//   victim     victim@aidbridge.test      Victim@12345
// Every other demo account uses Demo@12345.
import { Types } from 'mongoose'
import { config } from '../src/app/config'
import { Role } from '../src/app/constants/role'
import { IncidentStatus } from '../src/app/constants/incident'
import { ALL_ROLES_TARGET } from '../src/app/constants/notification'
import { DisasterType, Priority, ReliefCategory } from '../src/app/constants/relief'
import { MediaType, ResolvedBy, SosStatus } from '../src/app/constants/sos'
import { TaskStatus } from '../src/app/constants/task'
import type { Skill } from '../src/app/constants/skill'
import { VolunteerRequestStatus } from '../src/app/constants/volunteerRequest'
import { type Coordinates, toGeoPoint } from '../src/app/lib/geo'
import { connectDB, disconnectDB } from '../src/app/lib/db'
import { Camp } from '../src/app/module/camp/camp.model'
import { Distribution } from '../src/app/module/distribution/distribution.model'
import { Incident } from '../src/app/module/incident/incident.model'
import { Inventory } from '../src/app/module/inventory/inventory.model'
import { Message } from '../src/app/module/message/message.model'
import { Notification } from '../src/app/module/notification/notification.model'
import { SosRequest } from '../src/app/module/sos/sos.model'
import { Task } from '../src/app/module/task/task.model'
import { User } from '../src/app/module/user/user.model'
import { VolunteerRequest } from '../src/app/module/volunteer-request/volunteer-request.model'
import { hashPassword } from '../src/app/utils/password'

const DEMO_EMAIL_DOMAIN = '@aidbridge.test'
const SHARED_PASSWORD = 'Demo@12345'
const RESET_FLAG = '--reset'
const MS_PER_MINUTE = 60_000
const MS_PER_HOUR = 60 * MS_PER_MINUTE
const MS_PER_DAY = 24 * MS_PER_HOUR
const RATING_DECIMALS = 2

const now = Date.now()
const ago = ({ d = 0, h = 0, m = 0 }: { d?: number; h?: number; m?: number }) =>
  new Date(now - d * MS_PER_DAY - h * MS_PER_HOUR - m * MS_PER_MINUTE)

const id = () => new Types.ObjectId()
const point = (lng: number, lat: number) => toGeoPoint([lng, lat] as Coordinates)

// --- People -------------------------------------------------------------------------------------

interface PersonSeed {
  key: string
  name: string
  email: string
  role: Role
  phone: string
  password: string
  lng: number
  lat: number
  isAvailable?: boolean
  // Volunteers only. Skills use the Skill values from constants/skill.ts.
  skills?: Skill[]
  languages?: string[]
  joined: Date
}

const PEOPLE: PersonSeed[] = [
  // Admins
  { key: 'admin1', name: 'Habibur Rahman', email: 'admin', role: Role.ADMIN, phone: '+8801711000001', password: 'Admin@12345', lng: 90.4125, lat: 23.8103, joined: ago({ d: 120 }) },
  { key: 'admin2', name: 'Nusrat Jahan', email: 'nusrat.jahan', role: Role.ADMIN, phone: '+8801711000002', password: SHARED_PASSWORD, lng: 90.4125, lat: 23.8103, joined: ago({ d: 100 }) },
  // NGOs
  { key: 'ngo1', name: 'Shapla Relief Foundation', email: 'ngo', role: Role.NGO, phone: '+8801811000001', password: 'Ngo@12345', lng: 91.8687, lat: 24.8949, joined: ago({ d: 110 }) },
  { key: 'ngo2', name: 'Jonoseba Aid Network', email: 'jonoseba.aid', role: Role.NGO, phone: '+8801811000002', password: SHARED_PASSWORD, lng: 90.1266, lat: 22.0953, joined: ago({ d: 105 }) },
  { key: 'ngo3', name: 'Surma Relief Trust', email: 'surma.relief', role: Role.NGO, phone: '+8801811000003', password: SHARED_PASSWORD, lng: 91.395, lat: 25.0715, joined: ago({ d: 95 }) },
  // Volunteers (approved through a volunteer request, see VOLUNTEER_REQUESTS)
  { key: 'vol1', name: 'Tanvir Ahmed', email: 'volunteer', role: Role.VOLUNTEER, phone: '+8801911000001', password: 'Volunteer@123', lng: 91.8712, lat: 24.9001, skills: ['driving', 'food_distribution'], languages: ['Bangla', 'English'], joined: ago({ d: 90 }) },
  { key: 'vol2', name: 'Farhana Akter', email: 'farhana.akter', role: Role.VOLUNTEER, phone: '+8801911000002', password: SHARED_PASSWORD, lng: 91.4101, lat: 25.0602, skills: ['medical', 'first_aid'], languages: ['Bangla', 'English'], joined: ago({ d: 88 }) },
  { key: 'vol3', name: 'Mizanur Rahman', email: 'mizanur.rahman', role: Role.VOLUNTEER, phone: '+8801911000003', password: SHARED_PASSWORD, lng: 91.3912, lat: 25.0688, skills: ['boat', 'search_rescue'], languages: ['Bangla'], joined: ago({ d: 85 }) },
  { key: 'vol4', name: 'Sadia Islam', email: 'sadia.islam', role: Role.VOLUNTEER, phone: '+8801911000004', password: SHARED_PASSWORD, lng: 90.4003, lat: 23.7201, skills: ['first_aid', 'counselling'], languages: ['Bangla', 'English', 'Hindi'], joined: ago({ d: 80 }) },
  { key: 'vol5', name: 'Jahid Hasan', email: 'jahid.hasan', role: Role.VOLUNTEER, phone: '+8801911000005', password: SHARED_PASSWORD, lng: 90.1301, lat: 22.1002, skills: ['boat', 'driving'], languages: ['Bangla'], joined: ago({ d: 75 }) },
  { key: 'vol6', name: 'Rubel Mia', email: 'rubel.mia', role: Role.VOLUNTEER, phone: '+8801911000006', password: SHARED_PASSWORD, lng: 90.2402, lat: 21.9934, skills: ['search_rescue', 'boat'], languages: ['Bangla'], joined: ago({ d: 70 }) },
  { key: 'vol7', name: 'Anika Tabassum', email: 'anika.tabassum', role: Role.VOLUNTEER, phone: '+8801911000007', password: SHARED_PASSWORD, lng: 92.2201, lat: 22.1987, skills: ['shelter_management', 'food_distribution'], languages: ['Bangla', 'English'], joined: ago({ d: 65 }) },
  { key: 'vol8', name: 'Kamal Hossain', email: 'kamal.hossain', role: Role.VOLUNTEER, phone: '+8801911000008', password: SHARED_PASSWORD, lng: 91.8601, lat: 24.9075, isAvailable: false, skills: ['driving'], languages: ['Bangla'], joined: ago({ d: 60 }) },
  // Victims (the public sign-up role)
  { key: 'v1', name: 'Shirin Begum', email: 'victim', role: Role.VICTIM, phone: '+8801611000001', password: 'Victim@12345', lng: 91.3801, lat: 25.0554, joined: ago({ d: 50 }) },
  { key: 'v2', name: 'Abdul Karim', email: 'abdul.karim', role: Role.VICTIM, phone: '+8801611000002', password: SHARED_PASSWORD, lng: 91.8744, lat: 24.8977, joined: ago({ d: 45 }) },
  { key: 'v3', name: 'Rokeya Khatun', email: 'rokeya.khatun', role: Role.VICTIM, phone: '+8801611000003', password: SHARED_PASSWORD, lng: 91.4073, lat: 25.0658, joined: ago({ d: 44 }) },
  { key: 'v4', name: 'Shahidul Islam', email: 'shahidul.islam', role: Role.VICTIM, phone: '+8801611000004', password: SHARED_PASSWORD, lng: 90.1198, lat: 22.0901, joined: ago({ d: 43 }) },
  { key: 'v5', name: 'Nazma Akter', email: 'nazma.akter', role: Role.VICTIM, phone: '+8801611000005', password: SHARED_PASSWORD, lng: 90.237, lat: 21.999, joined: ago({ d: 42 }) },
  { key: 'v6', name: 'Habibur Rahman', email: 'habibur.rahman', role: Role.VICTIM, phone: '+8801611000006', password: SHARED_PASSWORD, lng: 90.3966, lat: 23.7156, joined: ago({ d: 41 }) },
  { key: 'v7', name: 'Salma Khatun', email: 'salma.khatun', role: Role.VICTIM, phone: '+8801611000007', password: SHARED_PASSWORD, lng: 90.3982, lat: 23.7143, joined: ago({ d: 41 }) },
  { key: 'v8', name: 'Jamal Uddin', email: 'jamal.uddin', role: Role.VICTIM, phone: '+8801611000008', password: SHARED_PASSWORD, lng: 92.2184, lat: 22.1953, joined: ago({ d: 40 }) },
  { key: 'v9', name: 'Parvin Sultana', email: 'parvin.sultana', role: Role.VICTIM, phone: '+8801611000009', password: SHARED_PASSWORD, lng: 92.1731, lat: 22.6533, joined: ago({ d: 39 }) },
  { key: 'v10', name: 'Liton Das', email: 'liton.das', role: Role.VICTIM, phone: '+8801611000010', password: SHARED_PASSWORD, lng: 89.65, lat: 25.805, joined: ago({ d: 38 }) },
  { key: 'v11', name: 'Ayesha Siddiqua', email: 'ayesha.siddiqua', role: Role.VICTIM, phone: '+8801611000011', password: SHARED_PASSWORD, lng: 91.8629, lat: 24.9102, joined: ago({ d: 37 }) },
  { key: 'v12', name: 'Rafiq Mia', email: 'rafiq.mia', role: Role.VICTIM, phone: '+8801611000012', password: SHARED_PASSWORD, lng: 91.3955, lat: 25.0731, joined: ago({ d: 36 }) },
  { key: 'v13', name: 'Monir Hossain', email: 'monir.hossain', role: Role.VICTIM, phone: '+8801611000013', password: SHARED_PASSWORD, lng: 91.98, lat: 21.4272, joined: ago({ d: 35 }) },
  { key: 'v14', name: 'Bithi Rani Roy', email: 'bithi.roy', role: Role.VICTIM, phone: '+8801611000014', password: SHARED_PASSWORD, lng: 89.6412, lat: 25.8101, joined: ago({ d: 34 }) },
]

const emailOf = (person: PersonSeed) => `${person.email}${DEMO_EMAIL_DOMAIN}`

// --- Seed data keyed by short names; ids are created up front so records can point at each other ---

const ids = new Map<string, Types.ObjectId>()
const idFor = (key: string) => {
  const existing = ids.get(key)
  if (existing) return existing
  const created = id()
  ids.set(key, created)
  return created
}

interface RatedTask {
  volunteer: string
  score: number
}

const DEMO_PASSWORD_HASHES = new Map<string, string>()
const hashOnce = async (password: string) => {
  const cached = DEMO_PASSWORD_HASHES.get(password)
  if (cached) return cached
  const hash = await hashPassword(password)
  DEMO_PASSWORD_HASHES.set(password, hash)
  return hash
}

// --- Volunteer requests -------------------------------------------------------------------------

const approvedRequest = (key: string, message: string, daysAgo: number) => ({
  user: idFor(key),
  message,
  status: VolunteerRequestStatus.APPROVED,
  reviewedBy: idFor('admin1'),
  reviewedAt: ago({ d: daysAgo - 1 }),
  reviewNote: 'Approved. Welcome to the team.',
  createdAt: ago({ d: daysAgo }),
  updatedAt: ago({ d: daysAgo - 1 }),
})

const VOLUNTEER_REQUESTS = [
  approvedRequest('vol1', 'I am a first-aid trained scout leader in Sylhet and own a boat. I can respond within 20 minutes of the city centre.', 92),
  approvedRequest('vol2', 'Final-year nursing student. I can help with first aid and basic medicine distribution around Companiganj.', 90),
  approvedRequest('vol3', 'I run a small trawler business on the Surma river and know the haor routes well. Available most days.', 87),
  approvedRequest('vol4', 'Worked with fire-service volunteers in Old Dhaka for three years. I can help with evacuation and relief logistics.', 82),
  approvedRequest('vol5', 'Grew up in Barguna and lived through Sidr. I want to help coastal families prepare and recover.', 77),
  approvedRequest('vol6', 'I have a motorbike and know every embankment path in Kalapara. Can carry small supplies and medicine.', 72),
  approvedRequest('vol7', 'Hill-tract local and a trained climber. I can reach landslide-hit paras that vehicles cannot.', 67),
  approvedRequest('vol8', 'Retired school teacher with free time. I can run a camp register and help families find relatives.', 62),
  {
    user: idFor('v11'),
    message: 'I am a pharmacy assistant in Sylhet city. I can help sort and hand out medicines at the camp.',
    status: VolunteerRequestStatus.PENDING,
    createdAt: ago({ d: 1, h: 4 }),
    updatedAt: ago({ d: 1, h: 4 }),
  },
  {
    user: idFor('v12'),
    message: 'My village was flooded last week and the relief teams helped us. I want to pay it back and I know the local roads.',
    status: VolunteerRequestStatus.PENDING,
    createdAt: ago({ h: 20 }),
    updatedAt: ago({ h: 20 }),
  },
  {
    user: idFor('v13'),
    message: 'I want to volunteer.',
    status: VolunteerRequestStatus.REJECTED,
    reviewedBy: idFor('admin2'),
    reviewedAt: ago({ d: 6 }),
    reviewNote: 'Please add details about your experience and availability, then apply again.',
    createdAt: ago({ d: 7 }),
    updatedAt: ago({ d: 6 }),
  },
]

// --- Incidents ----------------------------------------------------------------------------------

interface IncidentSeed {
  key: string
  title: string
  disasterType: DisasterType
  lng: number
  lat: number
  address: string
  description: string
  startDaysAgo: number
  endDaysAgo?: number
  status: IncidentStatus
  priority: Priority
}

const INCIDENTS: IncidentSeed[] = [
  { key: 'inc-sylhet-flood', title: 'Sylhet Division Monsoon Flood', disasterType: DisasterType.FLOOD, lng: 91.8687, lat: 24.8949, address: 'Sylhet Sadar and Companiganj, Sylhet', description: 'Heavy upstream rain from Meghalaya pushed the Surma and Kushiyara over their danger marks. Low-lying wards of Sylhet city and Companiganj are under 3-5 feet of water. Roads to several unions are cut and shelters are filling fast.', startDaysAgo: 9, status: IncidentStatus.ACTIVE, priority: Priority.CRITICAL },
  { key: 'inc-sunamganj-flood', title: 'Sunamganj Haor Flash Flood', disasterType: DisasterType.FLOOD, lng: 91.395, lat: 25.0715, address: 'Sunamganj Sadar and Jamalganj, Sunamganj', description: 'A haor embankment breached overnight and flash floodwater swept through nearby villages. Families are stranded on rooftops and school buildings; boats are the only way in.', startDaysAgo: 6, status: IncidentStatus.ACTIVE, priority: Priority.HIGH },
  { key: 'inc-cyclone', title: 'Cyclone Meghna - Barguna and Patuakhali Landfall', disasterType: DisasterType.CYCLONE, lng: 90.2, lat: 22.04, address: 'Barguna Sadar, Amtali and Kalapara upazilas', description: 'Severe cyclonic storm made landfall with a 6-8 ft tidal surge. Thousands moved into cyclone centres; tin-roofed homes and embankments are damaged along the coast.', startDaysAgo: 3, status: IncidentStatus.ACTIVE, priority: Priority.HIGH },
  { key: 'inc-landslide', title: 'Bandarban Hill Landslide', disasterType: DisasterType.LANDSLIDE, lng: 92.2184, lat: 22.1953, address: 'Bandarban Sadar and Rangamati hill road', description: 'Continuous rain triggered landslides that buried houses and cut the Bandarban-Rangamati road. Rescue teams are reaching the paras on foot.', startDaysAgo: 4, status: IncidentStatus.ACTIVE, priority: Priority.HIGH },
  { key: 'inc-fire', title: 'Chawkbazar Warehouse Fire', disasterType: DisasterType.FIRE, lng: 90.3966, lat: 23.7156, address: 'Chawkbazar, Old Dhaka', description: 'A chemical-store fire spread to neighbouring tenements overnight. Dozens of families lost their homes; the fire was brought under control within eleven hours.', startDaysAgo: 40, endDaysAgo: 39, status: IncidentStatus.RESOLVED, priority: Priority.MEDIUM },
  { key: 'inc-tremor', title: 'Sylhet Region 5.1 Magnitude Earthquake', disasterType: DisasterType.EARTHQUAKE, lng: 91.88, lat: 24.9, address: 'Sylhet city and nearby upazilas', description: 'A moderate earthquake cracked several old buildings. No deaths were reported; a few families were temporarily moved out of unsafe homes.', startDaysAgo: 62, endDaysAgo: 60, status: IncidentStatus.RESOLVED, priority: Priority.LOW },
]

// --- SOS requests and tasks ---------------------------------------------------------------------

interface SosSeed {
  key: string
  victim: string
  needs: ReliefCategory[]
  description: string
  lng: number
  lat: number
  address: string
  priority: Priority
  status: SosStatus
  volunteer?: string
  incident?: string
  created: Date
  media?: string[]
  resolvedBy?: ResolvedBy
  resolveReason?: string
  resolvedAt?: Date
}

const {
  FOOD, MEDICINE, SHELTER, WATER, CLOTHING,
} = ReliefCategory
const { PENDING, ASSIGNED, ON_THE_WAY, RESCUED, CLOSED } = SosStatus

const SOS: SosSeed[] = [
  // Sylhet flood
  { key: 's1', victim: 'v2', needs: [WATER, FOOD], description: 'Water has entered the ground floor. Six of us are on the first floor and the drinking water ran out last night. There is an elderly person and two small children.', lng: 91.8744, lat: 24.8977, address: 'Zindabazar, Sylhet Sadar', priority: Priority.HIGH, status: PENDING, incident: 'inc-sylhet-flood', created: ago({ h: 5 }) },
  { key: 's2', victim: 'v3', needs: [SHELTER, MEDICINE], description: 'Our mud house collapsed in the night. My mother is diabetic and needs insulin; her stock got washed away. We are sheltering in a neighbour\'s tin shed.', lng: 91.4073, lat: 25.0658, address: 'Companiganj Sadar, Sylhet', priority: Priority.CRITICAL, status: ASSIGNED, volunteer: 'vol2', incident: 'inc-sylhet-flood', created: ago({ d: 1 }), media: ['collapsed-house'] },
  { key: 's3', victim: 'v2', needs: [FOOD], description: 'No dry food left at home since the road went under water. Four adults and two children.', lng: 91.8751, lat: 24.8962, address: 'Zindabazar, Sylhet Sadar', priority: Priority.MEDIUM, status: CLOSED, volunteer: 'vol1', incident: 'inc-sylhet-flood', created: ago({ d: 7 }), resolvedBy: ResolvedBy.VICTIM, resolvedAt: ago({ d: 6, h: 20 }) },
  { key: 's17', victim: 'v11', needs: [FOOD, WATER], description: 'Stuck in the building with my parents. Neighbours are sharing what little they have.', lng: 91.8629, lat: 24.9102, address: 'Amberkhana, Sylhet', priority: Priority.MEDIUM, status: CLOSED, volunteer: 'vol8', incident: 'inc-sylhet-flood', created: ago({ d: 8 }), resolvedBy: ResolvedBy.VICTIM, resolvedAt: ago({ d: 7, h: 18 }) },
  { key: 's18', victim: 'v3', needs: [FOOD], description: 'Our family of five has had only flattened rice for two days.', lng: 91.4081, lat: 25.0649, address: 'Companiganj Sadar, Sylhet', priority: Priority.MEDIUM, status: CLOSED, volunteer: 'vol2', incident: 'inc-sylhet-flood', created: ago({ d: 9 }), resolvedBy: ResolvedBy.VICTIM, resolvedAt: ago({ d: 8, h: 20 }) },
  { key: 's20', victim: 'v2', needs: [WATER], description: 'The tube well is submerged and the water is unsafe to drink.', lng: 91.8738, lat: 24.8983, address: 'Zindabazar, Sylhet Sadar', priority: Priority.MEDIUM, status: CLOSED, volunteer: 'vol1', created: ago({ d: 25 }), resolvedBy: ResolvedBy.VICTIM, resolvedAt: ago({ d: 24, h: 21 }) },
  // Sunamganj flash flood
  { key: 's4', victim: 'v1', needs: [FOOD, WATER, SHELTER], description: 'The haor embankment broke and our village is under four feet of water. About 40 people from 9 families are on the school roof. We have no food and the children are crying from thirst.', lng: 91.3801, lat: 25.0554, address: 'Jamalganj Road, Sunamganj', priority: Priority.CRITICAL, status: ON_THE_WAY, volunteer: 'vol3', incident: 'inc-sunamganj-flood', created: ago({ h: 9 }), media: ['school-roof-flood'] },
  { key: 's5', victim: 'v1', needs: [MEDICINE], description: 'My youngest has had fever and loose motions for two days. We need ORS and fever medicine.', lng: 91.3809, lat: 25.0561, address: 'Jamalganj Road, Sunamganj', priority: Priority.HIGH, status: RESCUED, volunteer: 'vol3', incident: 'inc-sunamganj-flood', created: ago({ d: 2 }) },
  { key: 's6', victim: 'v12', needs: [CLOTHING, FOOD], description: 'We left in a hurry with only the clothes we are wearing. A family of seven, with a newborn.', lng: 91.3955, lat: 25.0731, address: 'Sunamganj Sadar', priority: Priority.MEDIUM, status: PENDING, incident: 'inc-sunamganj-flood', created: ago({ d: 1, h: 2 }) },
  { key: 's21', victim: 'v3', needs: [SHELTER], description: 'Floodwater in the house; need a tarpaulin and a dry place to sleep.', lng: 91.4066, lat: 25.0663, address: 'Companiganj Sadar, Sylhet', priority: Priority.MEDIUM, status: CLOSED, volunteer: 'vol3', created: ago({ d: 20 }), resolvedBy: ResolvedBy.VICTIM, resolvedAt: ago({ d: 19, h: 18 }) },
  // Cyclone
  { key: 's7', victim: 'v4', needs: [SHELTER, WATER], description: 'The roof of our tin house blew off. The cyclone centre is overflowing and we need space and clean water for 8 people.', lng: 90.1198, lat: 22.0901, address: 'Barguna Sadar, Barguna', priority: Priority.HIGH, status: ASSIGNED, volunteer: 'vol5', incident: 'inc-cyclone', created: ago({ d: 1, h: 6 }) },
  { key: 's8', victim: 'v5', needs: [FOOD, MEDICINE], description: 'The tidal surge has cut us off from the main road. Stranded with 12 people, one with a high fever. The water is up to the knee.', lng: 90.237, lat: 21.999, address: 'Kalapara, Patuakhali', priority: Priority.CRITICAL, status: ON_THE_WAY, volunteer: 'vol6', incident: 'inc-cyclone', created: ago({ h: 7 }) },
  { key: 's9', victim: 'v4', needs: [CLOTHING], description: 'Clothes and bedding got soaked by the storm surge.', lng: 90.1204, lat: 22.0895, address: 'Barguna Sadar, Barguna', priority: Priority.LOW, status: CLOSED, volunteer: 'vol5', incident: 'inc-cyclone', created: ago({ d: 2, h: 12 }), resolvedBy: ResolvedBy.VICTIM, resolvedAt: ago({ d: 2 }) },
  { key: 's22', victim: 'v5', needs: [FOOD], description: 'Waiting out the storm warning; no food stock for the children.', lng: 90.2377, lat: 21.9985, address: 'Kalapara, Patuakhali', priority: Priority.MEDIUM, status: CLOSED, volunteer: 'vol6', created: ago({ d: 22 }), resolvedBy: ResolvedBy.VICTIM, resolvedAt: ago({ d: 21, h: 20 }) },
  // Landslide
  { key: 's12', victim: 'v8', needs: [SHELTER, FOOD], description: 'A landslide buried three houses in our para and blocked the road. Eleven people are in the community hut and need shelter and food.', lng: 92.2184, lat: 22.1953, address: 'Rajbila, Bandarban Sadar', priority: Priority.CRITICAL, status: ASSIGNED, volunteer: 'vol7', incident: 'inc-landslide', created: ago({ d: 1, h: 3 }), media: ['landslide-road'] },
  { key: 's13', victim: 'v9', needs: [MEDICINE], description: 'My husband fractured his leg when the hillside slid. We can\'t get him to the hospital because the road is cut.', lng: 92.1731, lat: 22.6533, address: 'Reserve Bazar, Rangamati', priority: Priority.HIGH, status: PENDING, incident: 'inc-landslide', created: ago({ h: 3 }) },
  { key: 's19', victim: 'v9', needs: [SHELTER], description: 'Heavy rain damaged our roof. We need a tarpaulin to protect the children.', lng: 92.1742, lat: 22.6521, address: 'Reserve Bazar, Rangamati', priority: Priority.LOW, status: CLOSED, volunteer: 'vol7', created: ago({ d: 15 }), resolvedBy: ResolvedBy.VICTIM, resolvedAt: ago({ d: 14, h: 22 }) },
  // Fire
  { key: 's10', victim: 'v6', needs: [SHELTER, CLOTHING, MEDICINE], description: 'The fire destroyed our tenement. We escaped with nothing; my wife has smoke-inhalation symptoms and a burn on her arm.', lng: 90.3966, lat: 23.7156, address: 'Chawkbazar, Old Dhaka', priority: Priority.CRITICAL, status: CLOSED, volunteer: 'vol4', incident: 'inc-fire', created: ago({ d: 40 }), resolvedBy: ResolvedBy.VICTIM, resolvedAt: ago({ d: 38 }) },
  { key: 's11', victim: 'v7', needs: [MEDICINE], description: 'Neighbour\'s child has burns on the feet and needs dressing and pain medicine.', lng: 90.3982, lat: 23.7143, address: 'Chawkbazar, Old Dhaka', priority: Priority.HIGH, status: CLOSED, volunteer: 'vol4', incident: 'inc-fire', created: ago({ d: 40, h: 2 }), resolvedBy: ResolvedBy.VICTIM, resolvedAt: ago({ d: 39, h: 12 }) },
  // No incident / other
  { key: 's14', victim: 'v10', needs: [FOOD, SHELTER], description: 'The Brahmaputra has eaten away our homestead. Six families are living on the embankment road under plastic sheets.', lng: 89.65, lat: 25.805, address: 'Chilmari, Kurigram', priority: Priority.MEDIUM, status: PENDING, created: ago({ d: 2 }) },
  { key: 's15', victim: 'v14', needs: [WATER], description: 'The only tube well in our char has gone under water.', lng: 89.6412, lat: 25.8101, address: 'Chilmari, Kurigram', priority: Priority.LOW, status: PENDING, created: ago({ h: 12 }) },
  { key: 's16', victim: 'v13', needs: [SHELTER], description: 'Waves broke our fence and the roof leaks.', lng: 91.98, lat: 21.4272, address: 'Kolatoli, Cox\'s Bazar', priority: Priority.LOW, status: CLOSED, created: ago({ d: 5 }), resolvedBy: ResolvedBy.VICTIM, resolveReason: 'Neighbours helped us repair the roof. No longer need help.', resolvedAt: ago({ d: 4, h: 18 }) },
]

interface TaskSeed {
  sos: string
  volunteer: string
  status: TaskStatus
  acceptedAgo?: { d?: number; h?: number }
  completedAgo?: { d?: number; h?: number }
  notes?: string
  rating?: number
}

const TASKS: TaskSeed[] = [
  { sos: 's1', volunteer: 'vol8', status: TaskStatus.REJECTED, notes: 'Not available today; please assign someone nearer.' },
  { sos: 's2', volunteer: 'vol2', status: TaskStatus.ACCEPTED, acceptedAgo: { h: 20 }, notes: 'Insulin and a tarpaulin loaded at the Companiganj camp; heading over once the boat arrives.' },
  { sos: 's3', volunteer: 'vol1', status: TaskStatus.COMPLETED, acceptedAgo: { d: 6, h: 23 }, completedAgo: { d: 6, h: 21 }, notes: 'Delivered 25 kg of rice and drinking water.', rating: 5 },
  { sos: 's17', volunteer: 'vol8', status: TaskStatus.COMPLETED, acceptedAgo: { d: 7, h: 20 }, completedAgo: { d: 7, h: 19 }, notes: 'Water and ORS handed over.', rating: 3 },
  { sos: 's18', volunteer: 'vol2', status: TaskStatus.COMPLETED, acceptedAgo: { d: 8, h: 23 }, completedAgo: { d: 8, h: 21 }, notes: 'Dry food and two blankets given.', rating: 5 },
  { sos: 's20', volunteer: 'vol1', status: TaskStatus.COMPLETED, acceptedAgo: { d: 24, h: 23 }, completedAgo: { d: 24, h: 22 }, notes: 'Water purification tablets handed over.', rating: 4 },
  { sos: 's4', volunteer: 'vol3', status: TaskStatus.ON_THE_WAY, acceptedAgo: { h: 7 }, notes: 'On the trawler with dry food and water; about 40 minutes from the school.' },
  { sos: 's5', volunteer: 'vol3', status: TaskStatus.COMPLETED, acceptedAgo: { d: 1, h: 22 }, completedAgo: { d: 1, h: 20 }, notes: 'ORS and paracetamol delivered; the child is stable.' },
  { sos: 's6', volunteer: 'vol3', status: TaskStatus.REJECTED, notes: 'Already working a critical rescue nearby; someone else should take this one.' },
  { sos: 's21', volunteer: 'vol3', status: TaskStatus.COMPLETED, acceptedAgo: { d: 19, h: 23 }, completedAgo: { d: 19, h: 20 }, notes: 'Tarpaulin and a hygiene kit given.', rating: 5 },
  { sos: 's7', volunteer: 'vol5', status: TaskStatus.ACCEPTED, acceptedAgo: { d: 1, h: 4 }, notes: 'Arranging space at the Amtali cyclone centre.' },
  { sos: 's8', volunteer: 'vol6', status: TaskStatus.ON_THE_WAY, acceptedAgo: { h: 6 }, notes: 'Wading through the surge water on foot with the first-aid kit.' },
  { sos: 's9', volunteer: 'vol5', status: TaskStatus.COMPLETED, acceptedAgo: { d: 2, h: 11 }, completedAgo: { d: 2, h: 8 }, notes: 'Clothing sets handed over.', rating: 4 },
  { sos: 's22', volunteer: 'vol6', status: TaskStatus.COMPLETED, acceptedAgo: { d: 21, h: 23 }, completedAgo: { d: 21, h: 22 }, notes: 'Food packets delivered.', rating: 4 },
  { sos: 's12', volunteer: 'vol7', status: TaskStatus.ACCEPTED, acceptedAgo: { d: 1, h: 1 }, notes: 'Hiking in with the Bandarban team; the road is still blocked.' },
  { sos: 's19', volunteer: 'vol7', status: TaskStatus.COMPLETED, acceptedAgo: { d: 14, h: 23 }, completedAgo: { d: 14, h: 22 }, notes: 'Tarpaulin installed.', rating: 5 },
  { sos: 's10', volunteer: 'vol4', status: TaskStatus.COMPLETED, acceptedAgo: { d: 39, h: 22 }, completedAgo: { d: 39, h: 12 }, notes: 'Family moved to the community hall; the burn was dressed.', rating: 5 },
  { sos: 's11', volunteer: 'vol4', status: TaskStatus.COMPLETED, acceptedAgo: { d: 39, h: 20 }, completedAgo: { d: 39, h: 14 }, notes: 'Burn dressing and pain relief arranged.', rating: 4 },
]

// Tasks whose victim has left a rating (isRated), by SOS key. Anything COMPLETED not listed in a
// task's `rating` stays unrated so the "rate this volunteer" flow still has something to do.

// --- Chats --------------------------------------------------------------------------------------

type ChatLine = readonly [sender: string, text: string]
const CHATS: Record<string, { startedAgo: { d?: number; h?: number }; lines: ChatLine[] }> = {
  s2: {
    startedAgo: { h: 21 },
    lines: [
      ['v3', 'Please hurry, my mother has not had insulin since yesterday morning.'],
      ['vol2', 'I am a nurse. Keep her lying down and give her water. I am bringing insulin and glucose from the camp.'],
      ['v3', 'Thank you. She is awake and drinking water.'],
      ['vol2', 'The boat is leaving in an hour. Can you tell me which landmark is closest to you?'],
      ['v3', 'The blue tin-roof shed next to the Companiganj bazar mosque.'],
    ],
  },
  s4: {
    startedAgo: { h: 8 },
    lines: [
      ['v1', 'We are on the roof of the primary school. The water is still rising.'],
      ['vol3', 'I have a trawler with dry food and water for 40 people. Stay on the roof and keep the children away from the edge.'],
      ['v1', 'Okay. How long will you take?'],
      ['vol3', 'About two hours through the haor. I will call before I reach you.'],
      ['v1', 'May Allah reward you. We will wave a red cloth so you can find us.'],
    ],
  },
  s5: {
    startedAgo: { d: 1, h: 23 },
    lines: [
      ['vol3', 'I have ORS and paracetamol. How old is the child?'],
      ['v1', 'He is three years old and has had loose motions since morning.'],
      ['vol3', 'Give one packet of ORS in a litre of clean water, a little at a time. I will arrive within the hour.'],
      ['v1', 'He is better after the medicine. Thank you.'],
    ],
  },
  s7: {
    startedAgo: { d: 1, h: 4 },
    lines: [
      ['vol5', 'I have spoken to the Amtali cyclone centre. They can take your family of 8 on the second floor.'],
      ['v4', 'Thank you. Can we bring drinking water with us?'],
      ['vol5', 'Bring what you can. I will have 20-litre jars waiting at the centre.'],
    ],
  },
  s8: {
    startedAgo: { h: 6 },
    lines: [
      ['v5', 'The water is up to our knees. My nephew still has a high fever.'],
      ['vol6', 'I am on my way on foot with a first-aid kit and some biscuits. I will be there in about 45 minutes.'],
      ['v5', 'Please hurry, we are at the end of the embankment road.'],
    ],
  },
  s12: {
    startedAgo: { d: 1 },
    lines: [
      ['vol7', 'I have accepted your request. The road is blocked so I am coming on foot with the Bandarban team.'],
      ['v8', 'We are all safe in the community hut but we have only rice for today.'],
      ['vol7', 'We will bring dry food and tarpaulins. Please avoid the slope behind the hut.'],
    ],
  },
  s3: {
    startedAgo: { d: 6, h: 23 },
    lines: [
      ['vol1', 'On my way with rice and water. Please be ready on the first floor.'],
      ['v2', 'Thank you, brother. We are ready.'],
      ['vol1', 'Delivered. Please let me know if you need anything else.'],
    ],
  },
}

// --- Camps and inventory ------------------------------------------------------------------------

interface CampSeed {
  key: string
  ngo: string
  name: string
  lng: number
  lat: number
  address: string
  capacity: number
  currentOccupancy: number
  isActive?: boolean
  volunteers: string[]
  created: Date
}

const CAMPS: CampSeed[] = [
  { key: 'c1', ngo: 'ngo1', name: 'Zindabazar Govt. Primary School Shelter', lng: 91.8697, lat: 24.8965, address: 'Zindabazar, Sylhet Sadar', capacity: 400, currentOccupancy: 268, volunteers: ['vol1', 'vol2', 'vol8'], created: ago({ d: 9 }) },
  { key: 'c2', ngo: 'ngo1', name: 'Companiganj Upazila Flood Shelter', lng: 91.4101, lat: 25.0679, address: 'Companiganj Sadar, Sylhet', capacity: 250, currentOccupancy: 231, volunteers: ['vol2'], created: ago({ d: 9 }) },
  { key: 'c3', ngo: 'ngo3', name: 'Sunamganj Sadar High School Camp', lng: 91.3985, lat: 25.0719, address: 'Sunamganj Sadar', capacity: 500, currentOccupancy: 340, volunteers: ['vol3'], created: ago({ d: 6 }) },
  { key: 'c4', ngo: 'ngo2', name: 'Amtali Cyclone Centre', lng: 90.2218, lat: 22.1304, address: 'Amtali, Barguna', capacity: 600, currentOccupancy: 410, volunteers: ['vol5', 'vol6'], created: ago({ d: 3 }) },
  { key: 'c5', ngo: 'ngo2', name: 'Kalapara Multipurpose Cyclone Shelter', lng: 90.2377, lat: 21.9985, address: 'Kalapara, Patuakhali', capacity: 350, currentOccupancy: 305, volunteers: ['vol6'], created: ago({ d: 3 }) },
  { key: 'c6', ngo: 'ngo3', name: 'Bandarban Sadar Relief Point', lng: 92.2171, lat: 22.1932, address: 'Rajbila, Bandarban Sadar', capacity: 120, currentOccupancy: 45, volunteers: ['vol7'], created: ago({ d: 4 }) },
  { key: 'c7', ngo: 'ngo2', name: 'Chawkbazar Community Hall Camp', lng: 90.3972, lat: 23.7149, address: 'Chawkbazar, Old Dhaka', capacity: 150, currentOccupancy: 0, isActive: false, volunteers: ['vol4'], created: ago({ d: 40 }) },
  // Dhaka, so the victim's "relief camps near you" map has something to show in the capital too.
  { key: 'c8', ngo: 'ngo1', name: 'Dhanmondi Govt. High School Shelter', lng: 90.376, lat: 23.7465, address: 'Dhanmondi, Dhaka', capacity: 300, currentOccupancy: 142, volunteers: [], created: ago({ d: 2 }) },
  { key: 'c9', ngo: 'ngo2', name: 'Mirpur Stadium Relief Camp', lng: 90.3631, lat: 23.8068, address: 'Mirpur-2, Dhaka', capacity: 500, currentOccupancy: 380, volunteers: [], created: ago({ d: 2 }) },
  { key: 'c10', ngo: 'ngo3', name: 'Uttara Community Centre Shelter', lng: 90.4003, lat: 23.8741, address: 'Sector 7, Uttara, Dhaka', capacity: 200, currentOccupancy: 200, volunteers: [], created: ago({ d: 2 }) },
  { key: 'c11', ngo: 'ngo1', name: 'Demra Flood Relief Centre', lng: 90.4953, lat: 23.7239, address: 'Demra, Dhaka', capacity: 350, currentOccupancy: 190, volunteers: [], created: ago({ d: 1 }) },
  { key: 'c12', ngo: 'ngo2', name: 'Jatrabari Primary School Camp', lng: 90.4344, lat: 23.7104, address: 'Jatrabari, Dhaka', capacity: 180, currentOccupancy: 60, volunteers: [], created: ago({ d: 1 }) },
  { key: 'c13', ngo: 'ngo3', name: 'Tejgaon College Field Shelter', lng: 90.3917, lat: 23.7587, address: 'Tejgaon, Dhaka', capacity: 250, currentOccupancy: 95, volunteers: [], created: ago({ d: 1 }) },
]

interface InventorySeed {
  key: string
  ngo: string
  camp?: string
  itemName: string
  category: ReliefCategory
  quantity: number
  unit: string
  lowStockThreshold: number
}

const INVENTORY: InventorySeed[] = [
  // Shapla Relief Foundation - Sylhet
  { key: 'rice-c1', ngo: 'ngo1', camp: 'c1', itemName: 'Rice (coarse)', category: FOOD, quantity: 850, unit: 'kg', lowStockThreshold: 200 },
  { key: 'dal-c1', ngo: 'ngo1', camp: 'c1', itemName: 'Lentils (masoor dal)', category: FOOD, quantity: 120, unit: 'kg', lowStockThreshold: 150 },
  { key: 'water-c1', ngo: 'ngo1', camp: 'c1', itemName: 'Bottled drinking water (1.5 L)', category: WATER, quantity: 1400, unit: 'bottles', lowStockThreshold: 500 },
  { key: 'ors-c1', ngo: 'ngo1', camp: 'c1', itemName: 'ORS sachets', category: MEDICINE, quantity: 90, unit: 'sachets', lowStockThreshold: 200 },
  { key: 'blanket-c2', ngo: 'ngo1', camp: 'c2', itemName: 'Blankets', category: CLOTHING, quantity: 180, unit: 'pcs', lowStockThreshold: 50 },
  { key: 'tarp-c2', ngo: 'ngo1', camp: 'c2', itemName: 'Tarpaulin sheets', category: SHELTER, quantity: 60, unit: 'pcs', lowStockThreshold: 40 },
  { key: 'tabs-store1', ngo: 'ngo1', itemName: 'Water purification tablets', category: WATER, quantity: 5000, unit: 'tablets', lowStockThreshold: 1000 },
  { key: 'para-store1', ngo: 'ngo1', itemName: 'Paracetamol 500 mg', category: MEDICINE, quantity: 3200, unit: 'tablets', lowStockThreshold: 500 },
  // Surma Relief Trust - Sunamganj / hills
  { key: 'rice-c3', ngo: 'ngo3', camp: 'c3', itemName: 'Rice (coarse)', category: FOOD, quantity: 1100, unit: 'kg', lowStockThreshold: 300 },
  { key: 'chira-c3', ngo: 'ngo3', camp: 'c3', itemName: 'Flattened rice (chira)', category: FOOD, quantity: 300, unit: 'kg', lowStockThreshold: 100 },
  { key: 'biscuit-c3', ngo: 'ngo3', camp: 'c3', itemName: 'High-energy biscuits', category: FOOD, quantity: 40, unit: 'cartons', lowStockThreshold: 50 },
  { key: 'saline-c3', ngo: 'ngo3', camp: 'c3', itemName: 'IV saline bags (500 ml)', category: MEDICINE, quantity: 75, unit: 'bags', lowStockThreshold: 100 },
  { key: 'hygiene-c3', ngo: 'ngo3', camp: 'c3', itemName: 'Family hygiene kit', category: ReliefCategory.OTHER, quantity: 260, unit: 'kits', lowStockThreshold: 60 },
  { key: 'foodpack-c6', ngo: 'ngo3', camp: 'c6', itemName: 'Dry food packs', category: FOOD, quantity: 150, unit: 'packs', lowStockThreshold: 60 },
  { key: 'tarp-c6', ngo: 'ngo3', camp: 'c6', itemName: 'Tarpaulin sheets', category: SHELTER, quantity: 35, unit: 'pcs', lowStockThreshold: 40 },
  { key: 'lifejacket-store3', ngo: 'ngo3', itemName: 'Life jackets', category: ReliefCategory.OTHER, quantity: 48, unit: 'pcs', lowStockThreshold: 20 },
  // Jonoseba Aid Network - coast
  { key: 'rice-c4', ngo: 'ngo2', camp: 'c4', itemName: 'Rice (coarse)', category: FOOD, quantity: 1500, unit: 'kg', lowStockThreshold: 400 },
  { key: 'jar-c4', ngo: 'ngo2', camp: 'c4', itemName: 'Drinking water jars (20 L)', category: WATER, quantity: 320, unit: 'jars', lowStockThreshold: 100 },
  { key: 'oil-c4', ngo: 'ngo2', camp: 'c4', itemName: 'Cooking oil', category: FOOD, quantity: 220, unit: 'litres', lowStockThreshold: 50 },
  { key: 'cloth-c4', ngo: 'ngo2', camp: 'c4', itemName: 'Clothing set (adult)', category: CLOTHING, quantity: 310, unit: 'sets', lowStockThreshold: 80 },
  { key: 'blanket-c5', ngo: 'ngo2', camp: 'c5', itemName: 'Blankets', category: CLOTHING, quantity: 95, unit: 'pcs', lowStockThreshold: 100 },
  { key: 'aid-c5', ngo: 'ngo2', camp: 'c5', itemName: 'First-aid kits', category: MEDICINE, quantity: 42, unit: 'kits', lowStockThreshold: 30 },
  { key: 'tin-c5', ngo: 'ngo2', camp: 'c5', itemName: 'Corrugated tin sheets', category: SHELTER, quantity: 0, unit: 'sheets', lowStockThreshold: 20 },
]

interface DistributionSeed {
  task: string // the SOS key of the task (one task per SOS in this data)
  item: string
  quantity: number
  notes?: string
  at: { d?: number; h?: number }
}

const DISTRIBUTIONS: DistributionSeed[] = [
  { task: 's3', item: 'rice-c1', quantity: 25, at: { d: 6, h: 21 }, notes: 'Handed over at the first-floor window by boat.' },
  { task: 's3', item: 'water-c1', quantity: 18, at: { d: 6, h: 21 } },
  { task: 's17', item: 'water-c1', quantity: 24, at: { d: 7, h: 19 } },
  { task: 's17', item: 'ors-c1', quantity: 10, at: { d: 7, h: 19 } },
  { task: 's20', item: 'water-c1', quantity: 12, at: { d: 24, h: 22 } },
  { task: 's18', item: 'blanket-c2', quantity: 3, at: { d: 8, h: 21 } },
  { task: 's5', item: 'saline-c3', quantity: 2, at: { d: 1, h: 20 } },
  { task: 's5', item: 'hygiene-c3', quantity: 1, at: { d: 1, h: 20 } },
  { task: 's21', item: 'hygiene-c3', quantity: 1, at: { d: 19, h: 20 } },
  { task: 's21', item: 'rice-c3', quantity: 30, at: { d: 19, h: 20 } },
  { task: 's9', item: 'cloth-c4', quantity: 4, at: { d: 2, h: 8 }, notes: 'Two adult and two children\'s sets.' },
  { task: 's22', item: 'aid-c5', quantity: 1, at: { d: 21, h: 22 } },
  { task: 's22', item: 'blanket-c5', quantity: 2, at: { d: 21, h: 22 } },
  { task: 's19', item: 'foodpack-c6', quantity: 6, at: { d: 14, h: 22 } },
]

// --- Notifications ------------------------------------------------------------------------------

interface NotificationSeed {
  title: string
  message: string
  targetRoles?: string[]
  targetUsers?: string[]
  isEmergencyBroadcast?: boolean
  createdBy?: string
  readBy?: string[]
  created: Date
}

const NOTIFICATIONS: NotificationSeed[] = [
  {
    title: 'Cyclone Meghna: move to a shelter now',
    message: 'Cyclone Meghna has made landfall on the Barguna-Patuakhali coast. If you live near the coast or an embankment, move to the nearest cyclone centre immediately and carry drinking water, dry food and your phone. Stay away from the river and keep your SOS request updated.',
    targetRoles: [ALL_ROLES_TARGET],
    isEmergencyBroadcast: true,
    createdBy: 'admin1',
    readBy: ['v4', 'v5', 'vol5', 'vol6', 'ngo2'],
    created: ago({ d: 3, h: 2 }),
  },
  {
    title: 'Volunteers needed in Sunamganj',
    message: 'Boats and trained swimmers are urgently needed in Sunamganj and Jamalganj. If you are available, set yourself as available in your profile and check the nearby SOS list.',
    targetRoles: [Role.VOLUNTEER],
    createdBy: 'admin1',
    readBy: ['vol3', 'vol1'],
    created: ago({ d: 5, h: 8 }),
  },
  {
    title: 'Low stock: ORS, saline and biscuits',
    message: 'Several camps in Sylhet and Sunamganj are below their low-stock threshold for ORS sachets, IV saline bags and high-energy biscuits. Please check your inventory alerts and restock or request supply from partner NGOs.',
    targetRoles: [Role.NGO],
    createdBy: 'admin2',
    readBy: ['ngo1'],
    created: ago({ d: 1, h: 6 }),
  },
  {
    title: 'Flood shelters open in Sylhet and Companiganj',
    message: 'Zindabazar Govt. Primary School and the Companiganj Upazila Flood Shelter are open with food, water and basic medicine. Companiganj is nearly full - please use the Zindabazar shelter if you can.',
    targetRoles: [Role.VICTIM, Role.VOLUNTEER],
    createdBy: 'admin1',
    readBy: ['v2'],
    created: ago({ d: 8, h: 5 }),
  },
  {
    title: 'Landslide warning: Bandarban and Rangamati',
    message: 'More rain is forecast for the hill districts. Avoid steep slopes and riverbanks, and move to the Bandarban Sadar Relief Point if you hear cracking or see new cracks in the ground.',
    targetRoles: [Role.VICTIM, Role.VOLUNTEER, Role.NGO],
    createdBy: 'admin1',
    readBy: ['v8'],
    created: ago({ d: 3, h: 20 }),
  },
  {
    title: 'Volunteer request approved',
    message: 'Your volunteer request was approved. You can now see nearby SOS requests and take tasks. Thank you for stepping up.',
    targetUsers: ['vol1'],
    readBy: ['vol1'],
    created: ago({ d: 91 }),
  },
  {
    title: 'Volunteer request not approved',
    message: 'Your volunteer request was not approved this time. Reviewer note: Please add details about your experience and availability, then apply again.',
    targetUsers: ['v13'],
    created: ago({ d: 6 }),
  },
]

// --- Seeding ------------------------------------------------------------------------------------

const demoUserIds = async () => {
  const users = await User.find({ email: { $regex: `${DEMO_EMAIL_DOMAIN.replace('.', '\\.')}$` } })
    .select('_id')
    .lean()
  return users.map((user) => user._id)
}

const deleteDemoData = async (userIds: Types.ObjectId[]) => {
  const sosIds = (await SosRequest.find({ victim: { $in: userIds } }).select('_id').lean()).map(
    (sos) => sos._id,
  )
  const counts = {
    distributions: (await Distribution.deleteMany({ ngo: { $in: userIds } })).deletedCount,
    inventory: (await Inventory.deleteMany({ ngo: { $in: userIds } })).deletedCount,
    camps: (await Camp.deleteMany({ ngo: { $in: userIds } })).deletedCount,
    messages: (await Message.deleteMany({ sosRequest: { $in: sosIds } })).deletedCount,
    tasks: (await Task.deleteMany({ sosRequest: { $in: sosIds } })).deletedCount,
    sos: (await SosRequest.deleteMany({ _id: { $in: sosIds } })).deletedCount,
    incidents: (await Incident.deleteMany({ createdBy: { $in: userIds } })).deletedCount,
    notifications: (
      await Notification.deleteMany({
        $or: [{ createdBy: { $in: userIds } }, { targetUsers: { $in: userIds } }],
      })
    ).deletedCount,
    volunteerRequests: (await VolunteerRequest.deleteMany({ user: { $in: userIds } })).deletedCount,
    users: (await User.deleteMany({ _id: { $in: userIds } })).deletedCount,
  }
  console.log('Removed old demo data:', counts)
}

const personKeys = new Set(PEOPLE.map((person) => person.key))
const assertKnown = (key: string, where: string) => {
  if (!personKeys.has(key)) throw new Error(`Unknown person "${key}" in ${where}`)
}

const main = async () => {
  if (config.nodeEnv === 'production') {
    console.error('Refusing to seed demo data while NODE_ENV=production.')
    return 1
  }

  await connectDB()

  const existing = await demoUserIds()
  if (existing.length > 0) {
    if (!process.argv.includes(RESET_FLAG)) {
      console.error(
        `Demo data is already there (${existing.length} demo accounts). Run "npm run seed:demo -- ${RESET_FLAG}" to rebuild it.`,
      )
      return 1
    }
    await deleteDemoData(existing)
  }

  for (const task of TASKS) {
    assertKnown(task.volunteer, 'TASKS')
  }

  // Indexes first, so the unique/2dsphere rules are enforced while inserting.
  await Promise.all(
    [User, SosRequest, Task, Camp, Incident, Inventory, Message, Notification, VolunteerRequest, Distribution].map(
      (model) => model.init(),
    ),
  )

  // Ratings come from the rated tasks, so a volunteer's score always matches the tasks behind it.
  const ratings = new Map<string, number[]>()
  for (const task of TASKS) {
    if (task.rating === undefined) continue
    ratings.set(task.volunteer, [...(ratings.get(task.volunteer) ?? []), task.rating])
  }

  const users = await Promise.all(
    PEOPLE.map(async (person) => {
      const scores = ratings.get(person.key) ?? []
      const ratingSum = scores.reduce((sum, score) => sum + score, 0)
      const reliabilityScore =
        scores.length === 0
          ? 5
          : Number((ratingSum / scores.length).toFixed(RATING_DECIMALS))
      return {
        _id: idFor(person.key),
        name: person.name,
        email: emailOf(person),
        password: await hashOnce(person.password),
        role: person.role,
        phone: person.phone,
        isAvailable: person.isAvailable ?? true,
        skills: person.skills ?? [],
        languages: person.languages ?? [],
        location: point(person.lng, person.lat),
        reliabilityScore,
        totalRatings: scores.length,
        ratingSum,
        createdAt: person.joined,
        updatedAt: person.joined,
      }
    }),
  )
  await User.insertMany(users)
  await VolunteerRequest.insertMany(VOLUNTEER_REQUESTS)

  const incidentSosIds = new Map<string, Types.ObjectId[]>()
  const sosDocs = SOS.map((sos) => {
    assertKnown(sos.victim, `SOS ${sos.key}`)
    if (sos.volunteer) assertKnown(sos.volunteer, `SOS ${sos.key}`)
    if (sos.incident) {
      incidentSosIds.set(sos.incident, [...(incidentSosIds.get(sos.incident) ?? []), idFor(sos.key)])
    }
    const finished = sos.status === CLOSED || sos.status === RESCUED
    return {
      _id: idFor(sos.key),
      victim: idFor(sos.victim),
      needs: sos.needs,
      description: sos.description,
      media: (sos.media ?? []).map((name) => ({
        url: `https://res.cloudinary.com/aidbridge-demo/image/upload/v1/aidbridge/sos/${name}.jpg`,
        publicId: `aidbridge/sos/${name}`,
        resourceType: MediaType.IMAGE,
      })),
      location: point(sos.lng, sos.lat),
      address: sos.address,
      priority: sos.priority,
      status: sos.status,
      assignedVolunteer: sos.volunteer ? idFor(sos.volunteer) : null,
      ...(sos.status === CLOSED
        ? {
            resolvedAt: sos.resolvedAt,
            resolvedBy: sos.resolvedBy,
            ...(sos.resolveReason ? { resolveReason: sos.resolveReason } : {}),
          }
        : {}),
      createdAt: sos.created,
      updatedAt: finished && sos.resolvedAt ? sos.resolvedAt : sos.created,
    }
  })
  await SosRequest.insertMany(sosDocs)

  await Incident.insertMany(
    INCIDENTS.map((incident) => ({
      _id: idFor(incident.key),
      createdBy: idFor('admin1'),
      title: incident.title,
      disasterType: incident.disasterType,
      location: point(incident.lng, incident.lat),
      address: incident.address,
      description: incident.description,
      startDate: ago({ d: incident.startDaysAgo }),
      ...(incident.endDaysAgo !== undefined ? { endDate: ago({ d: incident.endDaysAgo }) } : {}),
      status: incident.status,
      priority: incident.priority,
      sosRequests: incidentSosIds.get(incident.key) ?? [],
      createdAt: ago({ d: incident.startDaysAgo }),
      updatedAt: ago({ d: incident.endDaysAgo ?? 0, h: 2 }),
    })),
  )

  const sosByKey = new Map(SOS.map((sos) => [sos.key, sos]))
  const taskIds = new Map<string, Types.ObjectId>()
  const taskDocs = TASKS.map((task) => {
    const sos = sosByKey.get(task.sos)
    if (!sos) throw new Error(`Task points at unknown SOS "${task.sos}"`)
    const taskId = id()
    taskIds.set(task.sos, taskId)
    return {
      _id: taskId,
      sosRequest: idFor(task.sos),
      volunteer: idFor(task.volunteer),
      victim: idFor(sos.victim),
      status: task.status,
      ...(task.acceptedAgo ? { acceptedAt: ago(task.acceptedAgo) } : {}),
      ...(task.completedAgo ? { completedAt: ago(task.completedAgo) } : {}),
      notes: task.notes,
      isRated: task.rating !== undefined,
      createdAt: sos.created,
      updatedAt: task.completedAgo ? ago(task.completedAgo) : (task.acceptedAgo ? ago(task.acceptedAgo) : sos.created),
    }
  })
  await Task.insertMany(taskDocs)

  const messageDocs = Object.entries(CHATS).flatMap(([sosKey, chat]) =>
    chat.lines.map(([sender, content], index) => {
      const sentAt = new Date(ago(chat.startedAgo).getTime() + index * 7 * MS_PER_MINUTE)
      return {
        sosRequest: idFor(sosKey),
        sender: idFor(sender),
        content,
        createdAt: sentAt,
        updatedAt: sentAt,
      }
    }),
  )
  await Message.insertMany(messageDocs)

  await Camp.insertMany(
    CAMPS.map((camp) => ({
      _id: idFor(camp.key),
      ngo: idFor(camp.ngo),
      name: camp.name,
      location: point(camp.lng, camp.lat),
      address: camp.address,
      capacity: camp.capacity,
      currentOccupancy: camp.currentOccupancy,
      isActive: camp.isActive ?? true,
      assignedVolunteers: camp.volunteers.map(idFor),
      createdAt: camp.created,
      updatedAt: ago({ h: 3 }),
    })),
  )

  const inventoryBySeed = new Map(INVENTORY.map((item) => [item.key, item]))
  await Inventory.insertMany(
    INVENTORY.map((item) => ({
      _id: idFor(`inv-${item.key}`),
      ngo: idFor(item.ngo),
      camp: item.camp ? idFor(item.camp) : null,
      itemName: item.itemName,
      category: item.category,
      quantity: item.quantity,
      unit: item.unit,
      lowStockThreshold: item.lowStockThreshold,
      isLow: item.quantity <= item.lowStockThreshold,
      createdAt: ago({ d: 10 }),
      updatedAt: ago({ d: 1 }),
    })),
  )

  await Distribution.insertMany(
    DISTRIBUTIONS.map((distribution) => {
      const sos = sosByKey.get(distribution.task)
      const item = inventoryBySeed.get(distribution.item)
      const taskId = taskIds.get(distribution.task)
      if (!sos?.volunteer || !item?.camp || !taskId) {
        throw new Error(`Bad distribution seed: task "${distribution.task}", item "${distribution.item}"`)
      }
      // Like the API: stock comes from a camp, handed out by a volunteer assigned to that camp.
      const camp = CAMPS.find((candidate) => candidate.key === item.camp)
      if (!camp?.volunteers.includes(sos.volunteer)) {
        throw new Error(`${sos.volunteer} is not assigned to camp ${item.camp}`)
      }
      const victim = PEOPLE.find((person) => person.key === sos.victim)
      if (!victim) throw new Error(`Unknown victim "${sos.victim}"`)
      const when = ago(distribution.at)
      return {
        ngo: idFor(item.ngo),
        camp: idFor(camp.key),
        sosRequest: idFor(sos.key),
        task: taskId,
        volunteer: idFor(sos.volunteer),
        recipient: idFor(sos.victim),
        recipientName: victim.name,
        item: {
          inventoryItem: idFor(`inv-${item.key}`),
          itemName: item.itemName,
          category: item.category,
          quantity: distribution.quantity,
          unit: item.unit,
        },
        notes: distribution.notes,
        distributedAt: when,
        createdAt: when,
        updatedAt: when,
      }
    }),
  )

  await Notification.insertMany(
    NOTIFICATIONS.map((notification) => ({
      title: notification.title,
      message: notification.message,
      targetRoles: notification.targetRoles ?? [],
      targetUsers: (notification.targetUsers ?? []).map(idFor),
      isEmergencyBroadcast: notification.isEmergencyBroadcast ?? false,
      ...(notification.createdBy ? { createdBy: idFor(notification.createdBy) } : {}),
      readBy: (notification.readBy ?? []).map(idFor),
      createdAt: notification.created,
      updatedAt: notification.created,
    })),
  )

  console.log('Demo data created:')
  console.log(`  users ${users.length} | volunteer requests ${VOLUNTEER_REQUESTS.length} | incidents ${INCIDENTS.length}`)
  console.log(`  SOS requests ${sosDocs.length} | tasks ${taskDocs.length} | messages ${messageDocs.length}`)
  console.log(`  camps ${CAMPS.length} | inventory items ${INVENTORY.length} | distributions ${DISTRIBUTIONS.length} | notifications ${NOTIFICATIONS.length}`)
  console.log('\nLogins:')
  for (const person of PEOPLE.filter((p) => ['admin1', 'ngo1', 'vol1', 'v1'].includes(p.key))) {
    console.log(`  ${person.role.padEnd(10)} ${emailOf(person).padEnd(30)} ${person.password}`)
  }
  console.log(`  (every other demo account: password ${SHARED_PASSWORD})`)
  return 0
}

main()
  .then(async (code) => {
    await disconnectDB()
    process.exit(code)
  })
  .catch(async (error) => {
    console.error('Demo seed failed:', error)
    await disconnectDB()
    process.exit(1)
  })
