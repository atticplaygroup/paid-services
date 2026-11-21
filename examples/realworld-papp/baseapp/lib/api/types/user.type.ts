import { inputObjectType, interfaceType, objectType } from 'nexus';
import { Context } from '../context';

export interface AuthPayload {
  sub: string;
  user: string;
}

const BaseUser = interfaceType({
  name: 'BaseUser',
  definition(t) {
    t.nonNull.string('username');
    t.string('bio');
    t.string('image');
  },
});

const AuthUser = objectType({
  name: 'AuthUser',
  definition(t) {
    t.nonNull.string('id');
    t.implements('BaseUser');
  },
});

const Profile = objectType({
  name: 'Profile',
  definition(t) {
    t.implements('BaseUser');
    t.nonNull.boolean('following', {
      resolve: async ({ username }, _, context: Context) => {
        if (!context.currentUser) return false;
        const follows = await context.prisma.user
          .findUnique({
            where: { username },
          })
          .followedBy({ select: { followerId: true }, where: { followerId: context.currentUser.id } });
        return !!follows!.length;
      },
    });
  },
});

const UserUpdateInput = inputObjectType({
  name: 'UserUpdateInput',
  definition(t) { t.nonNull.string('username'); t.string('bio'); t.string('image'); },
});
export default [BaseUser, AuthUser, Profile, UserUpdateInput];
