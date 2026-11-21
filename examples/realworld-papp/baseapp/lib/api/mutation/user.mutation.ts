import { arg, mutationType, nonNull } from 'nexus';
import { updateUserInputSchema } from '../../validation/schema';
import { Context } from '../context';
export default mutationType({
  definition(t) {
    t.nonNull.field('updateUser', {
      type: 'AuthUser', args: { input: nonNull(arg({ type: 'UserUpdateInput' })) },
      authorize: (_, _args, ctx: Context) => !!ctx.currentUser,
      validate: () => ({ input: updateUserInputSchema }),
      resolve: (_, { input }, ctx: Context) => ctx.prisma.user.update({ where: { id: ctx.currentUser!.id }, data: input }),
    });
  },
});
