import { describe, expect, it } from 'vitest'
import { isSchoolRoute, schoolViews } from './schoolMode'

describe('school presentation navigation', () => {
  it('offers only district-provided landing views, independent of labels', () => {
    expect(schoolViews({ id: 'educateos', title: 'School', nav: [
      { label: 'My school', path: '/learn' },
      { label: 'Studio', path: '/teach' },
      { label: 'Family', path: '/learn/family' },
      { label: 'Admin', path: '/admin' },
    ] }).map(({ role }) => role)).toEqual(['student', 'teacher', 'guardian', 'admin'])
  })
  it('does not infer roles from class pages, labels, or missing connections', () => {
    expect(schoolViews(undefined)).toEqual([])
    expect(schoolViews({ id: 'educateos', title: 'Administrator', nav: [
      { label: 'Administration', path: '/learn/courses/one' },
    ] })).toEqual([])
  })
  it('contains routed school content to the existing School app', () => {
    expect(isSchoolRoute('/gatekeepers/educateos')).toBe(true)
    for (const path of ['/settings', '/workspace/one', '/gatekeepers/mcp', '/gatekeepers/educateos-extra']) {
      expect(isSchoolRoute(path)).toBe(false)
    }
  })
})
